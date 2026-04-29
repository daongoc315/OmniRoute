import ApiManagerPageClient from "./ApiManagerPageClient";
import { isApiKeyRevealEnabled, maskStoredApiKey } from "@/lib/apiKeyExposure";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { getApiKeyUsageSummary } from "@/lib/usageDb";

function sanitizeConnectionForClient(connection: Record<string, unknown>) {
  return {
    id: typeof connection.id === "string" ? connection.id : "",
    name: typeof connection.name === "string" ? connection.name : "",
    provider: typeof connection.provider === "string" ? connection.provider : "",
    isActive: connection.isActive !== false,
  };
}
function isAccessSchedule(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enabled === "boolean" &&
    typeof record.from === "string" &&
    typeof record.until === "string" &&
    Array.isArray(record.days) &&
    record.days.every((day) => typeof day === "number") &&
    typeof record.tz === "string"
  );
}

function sanitizeApiKeyForClient(key: Record<string, unknown>) {
  return {
    id: typeof key.id === "string" ? key.id : "",
    name: typeof key.name === "string" ? key.name : "",
    key: maskStoredApiKey(key.key) || "",
    allowedModels: Array.isArray(key.allowedModels)
      ? key.allowedModels.filter((value): value is string => typeof value === "string")
      : null,
    allowedConnections: Array.isArray(key.allowedConnections)
      ? key.allowedConnections.filter((value): value is string => typeof value === "string")
      : null,
    noLog: key.noLog === true,
    autoResolve: key.autoResolve === true,
    isActive: key.isActive !== false,
    maxSessions: typeof key.maxSessions === "number" ? key.maxSessions : 0,
    accessSchedule: isAccessSchedule(key.accessSchedule)
      ? (key.accessSchedule as {
          enabled: boolean;
          from: string;
          until: string;
          days: number[];
          tz: string;
        })
      : null,
    lastUsedAt: typeof key.lastUsedAt === "string" ? key.lastUsedAt : null,
    createdAt: typeof key.createdAt === "string" ? key.createdAt : "",
  };
}

export default async function ApiManagerPage() {
  const [keys, usageByApiKey, connections] = await Promise.all([
    getApiKeys(),
    getApiKeyUsageSummary(),
    getProviderConnections(),
  ]);

  const maskedKeys = keys.map((key) => sanitizeApiKeyForClient(key as Record<string, unknown>));
  const safeConnections = connections.map((connection) =>
    sanitizeConnectionForClient(connection as Record<string, unknown>)
  );

  return (
    <ApiManagerPageClient
      initialKeys={maskedKeys}
      initialUsageByApiKey={usageByApiKey}
      initialConnections={safeConnections}
      initialAllowKeyReveal={isApiKeyRevealEnabled()}
    />
  );
}
