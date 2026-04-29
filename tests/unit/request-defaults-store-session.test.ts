import test from "node:test";
import assert from "node:assert/strict";

const {
  buildOpenAIStoreSessionId,
  ensureOpenAIStoreSessionFallback,
  getClaudeCodeCompatibleRequestDefaults,
  normalizeProviderSpecificData,
  sanitizeProviderSpecificDataForResponse,
} = await import("../../src/lib/providers/requestDefaults.ts");

test("buildOpenAIStoreSessionId normalizes external and generated session ids", () => {
  assert.equal(
    buildOpenAIStoreSessionId("ext:client session/abc"),
    "omniroute-session-client-session-abc"
  );
  assert.equal(
    buildOpenAIStoreSessionId(" internal:session "),
    "omniroute-session-internal:session"
  );
  assert.equal(buildOpenAIStoreSessionId(""), undefined);
});

test("ensureOpenAIStoreSessionFallback injects session_id only when no stable cache key exists", () => {
  const injected = ensureOpenAIStoreSessionFallback({ model: "gpt-5.3-codex" }, "ext:session-1");
  assert.equal(injected.session_id, "omniroute-session-session-1");

  const withPromptCacheKey = ensureOpenAIStoreSessionFallback(
    { model: "gpt-5.3-codex", prompt_cache_key: "cache-123" },
    "ext:session-2"
  );
  assert.equal(withPromptCacheKey.session_id, undefined);

  const withConversation = ensureOpenAIStoreSessionFallback(
    { model: "gpt-5.3-codex", conversation_id: "conv-1" },
    "ext:session-3"
  );
  assert.equal(withConversation.session_id, undefined);

  const withExplicitSession = ensureOpenAIStoreSessionFallback(
    { model: "gpt-5.3-codex", session_id: "existing-session" },
    "ext:session-4"
  );
  assert.equal(withExplicitSession.session_id, "existing-session");
});

test("normalizeProviderSpecificData keeps only boolean CC-compatible 1M request defaults", () => {
  const normalized = normalizeProviderSpecificData("anthropic-compatible-cc-demo", {
    baseUrl: "https://proxy.example.com/v1/messages?beta=true",
    requestDefaults: {
      context1m: true,
      customFlag: "keep-me",
    },
  });

  assert.deepEqual(getClaudeCodeCompatibleRequestDefaults(normalized), {
    context1m: true,
  });
  assert.deepEqual(normalized?.requestDefaults, {
    context1m: true,
    customFlag: "keep-me",
  });

  const stripped = normalizeProviderSpecificData("anthropic-compatible-cc-demo", {
    requestDefaults: {
      context1m: "yes",
      customFlag: "keep-me",
    },
  });
  assert.deepEqual(stripped?.requestDefaults, {
    customFlag: "keep-me",
  });
});

test("sanitizeProviderSpecificDataForResponse strips nested provider secrets", () => {
  const sanitized = sanitizeProviderSpecificDataForResponse({
    clientId: "oFQi8yZO5yq_37FZ7H0JImFwLXNvdXRoZWFzdC0x",
    clientSecret: "kiro-client-secret",
    copilotToken: "copilot-token-secret",
    access_token: "access-token-secret",
    refreshToken: "refresh-token-secret",
    awsSessionToken: "aws-session-token-secret",
    privateKey: "private-key-secret",
    oauth: {
      clientSecret: "nested-client-secret",
      tenantId: "tenant-1",
    },
    headers: {
      authorizationToken: "nested-token-secret",
      organization: "org-1",
    },
    region: "ap-southeast-1",
    requestDefaults: { reasoningEffort: "high" },
  });

  assert.deepEqual(sanitized, {
    clientId: "oFQi8yZO5yq_37FZ7H0JImFwLXNvdXRoZWFzdC0x",
    oauth: { tenantId: "tenant-1" },
    headers: { organization: "org-1" },
    region: "ap-southeast-1",
    requestDefaults: { reasoningEffort: "high" },
  });
});
