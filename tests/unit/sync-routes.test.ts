import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sync-routes-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-sync-routes-secret";
process.env.INITIAL_PASSWORD = "sync-routes-password";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const syncTokensRoute = await import("../../src/app/api/sync/tokens/route.ts");
const syncTokenByIdRoute = await import("../../src/app/api/sync/tokens/[id]/route.ts");
const syncBundleRoute = await import("../../src/app/api/sync/bundle/route.ts");
const providersClientRoute = await import("../../src/app/api/providers/client/route.ts");
const localDb = await import("../../src/lib/localDb.ts");

function resetStorage() {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  resetStorage();
  await localDb.updateSettings({ requireLogin: true, password: "" });
});

test.after(() => {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }

  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }

  if (ORIGINAL_INITIAL_PASSWORD === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  }
});

test("sync token management requires management auth when login is enabled", async () => {
  const response = await syncTokensRoute.POST(
    new Request("http://localhost/api/sync/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Desktop client" }),
    })
  );

  assert.equal(response.status, 401);
});

test("providers client route requires management auth and redacts raw credentials", async () => {
  await localDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Primary OpenAI",
    apiKey: "sk-live-provider-secret",
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    idToken: "id-token-secret",
    providerSpecificData: {
      secret: "provider-specific-secret",
      clientSecret: "client-secret",
      tag: "prod",
    },
    defaultModel: "gpt-4o-mini",
  });

  const unauthenticatedResponse = await providersClientRoute.GET(
    new Request("http://localhost/api/providers/client")
  );
  assert.equal(unauthenticatedResponse.status, 401);

  const authenticatedResponse = await providersClientRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/client")
  );
  assert.equal(authenticatedResponse.status, 200);

  const body = (await authenticatedResponse.json()) as any;
  assert.equal(body.connections.length, 1);
  assert.equal(body.connections[0].name, "Primary OpenAI");
  assert.equal(body.connections[0].apiKey, undefined);
  assert.equal(body.connections[0].accessToken, undefined);
  assert.equal(body.connections[0].refreshToken, undefined);
  assert.equal(body.connections[0].idToken, undefined);
  assert.deepEqual(body.connections[0].providerSpecificData, { tag: "prod" });
});

test("sync token routes issue, list, use and revoke dedicated tokens", async () => {
  const managementKey = await apiKeysDb.createApiKey("Management", "machine-sync-routes");

  const createResponse = await syncTokensRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/sync/tokens", {
      method: "POST",
      token: managementKey.key,
      headers: {
        "x-request-id": "req-sync-token-create",
        "x-forwarded-for": "198.51.100.30",
      },
      body: { name: "Desktop client" },
    })
  );

  assert.equal(createResponse.status, 201);
  const createdBody = (await createResponse.json()) as any;
  assert.match(createdBody.token, /^osync_/);
  assert.equal(createdBody.syncToken.name, "Desktop client");
  assert.equal(createdBody.syncToken.syncApiKeyId, managementKey.id);

  const listResponse = await syncTokensRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/sync/tokens", {
      token: managementKey.key,
    })
  );
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as any;
  assert.equal(listed.total, 1);
  assert.equal(listed.tokens[0].name, "Desktop client");
  assert.equal(listed.tokens[0].lastUsedAt, null);
  assert.equal("token" in listed.tokens[0], false);

  const bundleResponse = await syncBundleRoute.GET(
    new Request("http://localhost/api/sync/bundle", {
      headers: {
        authorization: `Bearer ${createdBody.token}`,
      },
    })
  );
  assert.equal(bundleResponse.status, 200);
  assert.match(bundleResponse.headers.get("etag") || "", /^"[a-f0-9]{64}"$/);
  assert.match(bundleResponse.headers.get("x-config-version") || "", /^[a-f0-9]{64}$/);
  const bundlePayload = (await bundleResponse.json()) as any;
  assert.equal(bundlePayload.version, bundleResponse.headers.get("x-config-version"));
  assert.equal(typeof bundlePayload.bundle, "object");

  const secondListResponse = await syncTokensRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/sync/tokens", {
      token: managementKey.key,
    })
  );
  const secondListBody = (await secondListResponse.json()) as any;
  assert.equal(typeof secondListBody.tokens[0].lastUsedAt, "string");

  const notModifiedResponse = await syncBundleRoute.GET(
    new Request("http://localhost/api/sync/bundle", {
      headers: {
        authorization: `Bearer ${createdBody.token}`,
        "if-none-match": `"${bundlePayload.version}"`,
      },
    })
  );
  assert.equal(notModifiedResponse.status, 304);

  const revokeResponse = await syncTokenByIdRoute.DELETE(
    await makeManagementSessionRequest(
      `http://localhost/api/sync/tokens/${createdBody.syncToken.id}`,
      {
        method: "DELETE",
        token: managementKey.key,
        headers: {
          "x-request-id": "req-sync-token-revoke",
          "x-forwarded-for": "198.51.100.30",
        },
      }
    ),
    { params: Promise.resolve({ id: createdBody.syncToken.id }) }
  );

  assert.equal(revokeResponse.status, 200);
  const revokeBody = (await revokeResponse.json()) as any;
  assert.equal(typeof revokeBody.syncToken.revokedAt, "string");

  const revokedBundleResponse = await syncBundleRoute.GET(
    new Request("http://localhost/api/sync/bundle", {
      headers: {
        authorization: `Bearer ${createdBody.token}`,
      },
    })
  );
  assert.equal(revokedBundleResponse.status, 401);

  const auditActions = compliance.getAuditLog().map((entry: any) => entry.action);
  assert.equal(auditActions.includes("sync.token.created"), true);
  assert.equal(auditActions.includes("sync.token.revoked"), true);
});
