/**
 * Usage Stats — extracted from usageDb.js (T-15)
 *
 * Aggregates usage data into stats for the dashboard:
 * totals, by provider/model/account/apiKey, 10-minute buckets.
 *
 * @module lib/usage/usageStats
 */

import { getDbInstance } from "../db/core";
import { getPendingRequests } from "./usageHistory";
import { getAccountDisplayName } from "@/lib/display/names";
import { calculateCost, computeCostFromPricing, normalizeModelName } from "./costCalculator";

type JsonRecord = Record<string, unknown>;
type UsageBucket = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

type UsageBreakdown = UsageBucket & {
  rawModel?: string;
  provider?: string;
  lastUsed?: string;
  connectionId?: string;
  accountName?: string;
  apiKeyId?: string | null;
  apiKeyName?: string;
};

type ActiveRequest = {
  model: string;
  provider: string;
  account: string;
  count: number;
};

export type ApiKeyUsageSummary = UsageBucket & {
  apiKeyId: string | null;
  apiKeyName: string;
  firstUsed: string | null;
  lastUsed: string | null;
  totalTokens: number;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const DEFAULT_USAGE_STATS_WINDOW_DAYS = 30;
const MAX_USAGE_DB_ROWS = 20000;

function clampPositiveInteger(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function emptyApiKeyUsage(apiKeyId: string | null, apiKeyName: string): ApiKeyUsageSummary {
  return {
    apiKeyId,
    apiKeyName,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
    firstUsed: null,
    lastUsed: null,
    totalTokens: 0,
  };
}

function ensureApiKeyUsageBucket(
  target: Record<string, ApiKeyUsageSummary>,
  apiKeyId: string | null,
  apiKeyName: string | null
) {
  const normalizedId = apiKeyId || null;
  const normalizedName = apiKeyName || normalizedId || "unknown";
  const stableKey = normalizedId ? `id:${normalizedId}` : `name:${normalizedName}`;
  if (!target[stableKey]) {
    target[stableKey] = emptyApiKeyUsage(normalizedId, normalizedName);
  }
  return target[stableKey];
}

export async function getApiKeyUsageSummary(options: { sinceIso?: string | null } = {}) {
  const db = getDbInstance();
  const { getPricingForModel } = await import("@/lib/localDb");
  const whereClause = options.sinceIso ? "WHERE timestamp >= @since" : "";
  const apiKeyCondition = whereClause ? "AND" : "WHERE";
  const rows = db
    .prepare(
      `
      SELECT
        api_key_id AS apiKeyId,
        api_key_name AS apiKeyName,
        provider,
        model,
        COUNT(*) AS requests,
        SUM(COALESCE(tokens_input, 0)) AS promptTokens,
        SUM(COALESCE(tokens_output, 0)) AS completionTokens,
        SUM(COALESCE(tokens_cache_read, 0)) AS cacheReadTokens,
        SUM(COALESCE(tokens_cache_creation, 0)) AS cacheCreationTokens,
        SUM(COALESCE(tokens_reasoning, 0)) AS reasoningTokens,
        MIN(timestamp) AS firstUsed,
        MAX(timestamp) AS lastUsed
      FROM usage_history
      ${whereClause}
      ${apiKeyCondition} (api_key_id IS NOT NULL OR api_key_name IS NOT NULL)
      GROUP BY api_key_id, api_key_name, provider, model
      ORDER BY lastUsed DESC
    `
    )
    .all(options.sinceIso ? { since: options.sinceIso } : {}) as unknown[];

  const byApiKey: Record<string, ApiKeyUsageSummary> = {};
  const pricingCache = new Map<string, Promise<Record<string, unknown> | null>>();

  for (const rowRaw of rows) {
    const row = asRecord(rowRaw);
    const apiKeyId = toStringOrEmpty(row.apiKeyId) || null;
    const apiKeyName = toStringOrEmpty(row.apiKeyName) || null;
    if (!apiKeyId && !apiKeyName) continue;

    const provider = toStringOrEmpty(row.provider) || "unknown";
    const model = toStringOrEmpty(row.model) || "unknown";
    const promptTokens = toNumber(row.promptTokens);
    const completionTokens = toNumber(row.completionTokens);
    const entryTokens = {
      input: promptTokens,
      output: completionTokens,
      cacheRead: toNumber(row.cacheReadTokens),
      cacheCreation: toNumber(row.cacheCreationTokens),
      reasoning: toNumber(row.reasoningTokens),
    };
    const pricingKey = `${provider}\u0000${model}`;
    let pricingPromise = pricingCache.get(pricingKey);
    if (!pricingPromise) {
      pricingPromise = (async () => {
        let pricing = await getPricingForModel(provider, model);
        if (!pricing) {
          const normalized = normalizeModelName(model);
          if (normalized !== model) pricing = await getPricingForModel(provider, normalized);
        }
        return pricing && typeof pricing === "object" && !Array.isArray(pricing)
          ? (pricing as Record<string, unknown>)
          : null;
      })();
      pricingCache.set(pricingKey, pricingPromise);
    }
    const entryCost = computeCostFromPricing(await pricingPromise, entryTokens);

    const bucket = ensureApiKeyUsageBucket(byApiKey, apiKeyId, apiKeyName);
    bucket.requests += toNumber(row.requests);
    bucket.promptTokens += promptTokens;
    bucket.completionTokens += completionTokens;
    bucket.totalTokens += promptTokens + completionTokens;
    bucket.cost += entryCost;
    const firstUsed = toStringOrEmpty(row.firstUsed) || null;
    const lastUsed = toStringOrEmpty(row.lastUsed) || null;
    if (firstUsed && (!bucket.firstUsed || new Date(firstUsed) < new Date(bucket.firstUsed))) {
      bucket.firstUsed = firstUsed;
    }
    if (lastUsed && (!bucket.lastUsed || new Date(lastUsed) > new Date(bucket.lastUsed))) {
      bucket.lastUsed = lastUsed;
    }
  }

  return byApiKey;
}

function getBoundedUsageRows(options: { sinceIso?: string | null; maxRows?: number } = {}) {
  const db = getDbInstance();
  const maxRows = clampPositiveInteger(options.maxRows, MAX_USAGE_DB_ROWS, MAX_USAGE_DB_ROWS);
  const sinceIso =
    options.sinceIso ||
    new Date(Date.now() - DEFAULT_USAGE_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  return db
    .prepare(
      `
      SELECT * FROM (
        SELECT *
        FROM usage_history
        WHERE timestamp >= @sinceIso
        ORDER BY timestamp DESC
        LIMIT @maxRows
      )
      ORDER BY timestamp ASC
    `
    )
    .all({ sinceIso, maxRows }) as unknown[];
}

/**
 * Get aggregated usage stats.
 */
export async function getUsageStats(options: { sinceIso?: string | null; maxRows?: number } = {}) {
  const rows = getBoundedUsageRows(options);

  const { getProviderConnections } = await import("@/lib/localDb");
  let allConnections: unknown[] = [];
  try {
    const loadedConnections = await getProviderConnections();
    allConnections = Array.isArray(loadedConnections) ? loadedConnections : [];
  } catch {}

  const connectionMap: Record<string, string> = {};
  for (const connRaw of allConnections) {
    const conn = asRecord(connRaw);
    const connectionId = toStringOrEmpty(conn.id);
    if (!connectionId) continue;
    connectionMap[connectionId] =
      toStringOrEmpty(conn.name) || toStringOrEmpty(conn.email) || connectionId;
  }

  const pendingRequests = getPendingRequests();

  const stats: {
    totalRequests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCost: number;
    byProvider: Record<string, UsageBreakdown>;
    byModel: Record<string, UsageBreakdown>;
    byAccount: Record<string, UsageBreakdown>;
    byApiKey: Record<string, UsageBreakdown>;
    last10Minutes: UsageBucket[];
    pending: ReturnType<typeof getPendingRequests>;
    activeRequests: ActiveRequest[];
  } = {
    totalRequests: rows.length,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
  };

  // Build active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName =
          connectionMap[connectionId] || getAccountDisplayName({ id: connectionId });
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName,
          count,
        });
      }
    }
  }

  // 10-minute buckets
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);

  const bucketMap: Record<number, UsageBucket> = {};
  for (let i = 0; i < 10; i++) {
    const bucketTime = new Date(currentMinuteStart.getTime() - (9 - i) * 60 * 1000);
    const bucketKey = bucketTime.getTime();
    bucketMap[bucketKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[bucketKey]);
  }

  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);

  for (const rowRaw of rows) {
    const row = asRecord(rowRaw);
    const provider = toStringOrEmpty(row.provider) || "unknown";
    const model = toStringOrEmpty(row.model) || "unknown";
    const timestamp = toStringOrEmpty(row.timestamp) || new Date(0).toISOString();
    const connectionId = toStringOrEmpty(row.connection_id) || null;
    const apiKeyId = toStringOrEmpty(row.api_key_id) || null;
    const apiKeyName = toStringOrEmpty(row.api_key_name) || null;
    const promptTokens = toNumber(row.tokens_input);
    const completionTokens = toNumber(row.tokens_output);
    const entryTime = new Date(timestamp);

    const entryTokens = {
      input: toNumber(row.tokens_input),
      output: toNumber(row.tokens_output),
      cacheRead: toNumber(row.tokens_cache_read),
      cacheCreation: toNumber(row.tokens_cache_creation),
      reasoning: toNumber(row.tokens_reasoning),
    };
    const entryCost = await calculateCost(provider, model, entryTokens);

    stats.totalPromptTokens += promptTokens;
    stats.totalCompletionTokens += completionTokens;
    stats.totalCost += entryCost;

    // 10-min buckets
    if (entryTime >= tenMinutesAgo && entryTime <= now) {
      const entryMinuteStart = Math.floor(entryTime.getTime() / 60000) * 60000;
      if (bucketMap[entryMinuteStart]) {
        bucketMap[entryMinuteStart].requests++;
        bucketMap[entryMinuteStart].promptTokens += promptTokens;
        bucketMap[entryMinuteStart].completionTokens += completionTokens;
        bucketMap[entryMinuteStart].cost += entryCost;
      }
    }

    // By Provider
    if (!stats.byProvider[provider]) {
      stats.byProvider[provider] = {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
      };
    }
    stats.byProvider[provider].requests++;
    stats.byProvider[provider].promptTokens += promptTokens;
    stats.byProvider[provider].completionTokens += completionTokens;
    stats.byProvider[provider].cost += entryCost;

    // By Model
    const modelKey = provider ? `${model} (${provider})` : model;
    if (!stats.byModel[modelKey]) {
      stats.byModel[modelKey] = {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        rawModel: model,
        provider,
        lastUsed: timestamp,
      };
    }
    stats.byModel[modelKey].requests++;
    stats.byModel[modelKey].promptTokens += promptTokens;
    stats.byModel[modelKey].completionTokens += completionTokens;
    stats.byModel[modelKey].cost += entryCost;
    if (new Date(timestamp) > new Date(stats.byModel[modelKey].lastUsed || timestamp)) {
      stats.byModel[modelKey].lastUsed = timestamp;
    }

    // By Account
    if (connectionId) {
      const accountName =
        connectionMap[connectionId] || getAccountDisplayName({ id: connectionId });
      const accountKey = `${model} (${provider} - ${accountName})`;
      if (!stats.byAccount[accountKey]) {
        stats.byAccount[accountKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
          rawModel: model,
          provider,
          connectionId,
          accountName,
          lastUsed: timestamp,
        };
      }
      stats.byAccount[accountKey].requests++;
      stats.byAccount[accountKey].promptTokens += promptTokens;
      stats.byAccount[accountKey].completionTokens += completionTokens;
      stats.byAccount[accountKey].cost += entryCost;
      if (new Date(timestamp) > new Date(stats.byAccount[accountKey].lastUsed || timestamp)) {
        stats.byAccount[accountKey].lastUsed = timestamp;
      }
    }

    // By API key — intentionally bounded to the same rows as the rest of getUsageStats().
    // Full range API-key analytics are served by /api/usage/analytics via getApiKeyUsageSummary().
    if (apiKeyId || apiKeyName) {
      const keyName = apiKeyName || apiKeyId || "unknown";
      const keyId = apiKeyId || null;
      const apiKey = keyId ? `${keyName} (${keyId})` : keyName;
      if (!stats.byApiKey[apiKey]) {
        stats.byApiKey[apiKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
          apiKeyId: keyId,
          apiKeyName: keyName,
          lastUsed: timestamp,
        };
      }
      stats.byApiKey[apiKey].requests++;
      stats.byApiKey[apiKey].promptTokens += promptTokens;
      stats.byApiKey[apiKey].completionTokens += completionTokens;
      stats.byApiKey[apiKey].cost += entryCost;
      if (new Date(timestamp) > new Date(stats.byApiKey[apiKey].lastUsed || timestamp)) {
        stats.byApiKey[apiKey].lastUsed = timestamp;
      }
    }
  }

  return stats;
}
