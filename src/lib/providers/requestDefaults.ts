type JsonRecord = Record<string, unknown>;
const CLAUDE_CODE_COMPATIBLE_PROVIDER_PREFIX = "anthropic-compatible-cc-";

import { normalizeExcludedModelPatterns } from "@/domain/connectionModelRules";
import { normalizeRoutingTags } from "@/domain/tagRouter";

export const CODEX_REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh"] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_VALUES)[number];

const CODEX_REASONING_EFFORT_SET = new Set<string>(CODEX_REASONING_EFFORT_VALUES);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isClaudeCodeCompatibleProvider(provider: string | null | undefined): boolean {
  return (
    typeof provider === "string" && provider.startsWith(CLAUDE_CODE_COMPATIBLE_PROVIDER_PREFIX)
  );
}

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  const normalized = normalizeString(value);
  if (!normalized || !CODEX_REASONING_EFFORT_SET.has(normalized)) {
    return undefined;
  }
  return normalized as CodexReasoningEffort;
}

export function normalizeCodexServiceTier(value: unknown): "priority" | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  if (normalized === "fast" || normalized === "priority") return "priority";
  return undefined;
}

export function normalizeClaudeCodeCompatibleContext1m(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

export function normalizeRequestDefaults(
  provider: string | null | undefined,
  value: unknown
): JsonRecord | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;

  const normalized: JsonRecord = { ...record };

  if (provider === "codex") {
    const reasoningEffort = normalizeCodexReasoningEffort(record.reasoningEffort);
    if (reasoningEffort) {
      normalized.reasoningEffort = reasoningEffort;
    } else {
      delete normalized.reasoningEffort;
    }

    const serviceTier = normalizeCodexServiceTier(record.serviceTier);
    if (serviceTier) {
      normalized.serviceTier = serviceTier;
    } else {
      delete normalized.serviceTier;
    }
  }

  if (isClaudeCodeCompatibleProvider(provider)) {
    const context1m = normalizeClaudeCodeCompatibleContext1m(record.context1m);
    if (context1m) {
      normalized.context1m = true;
    } else {
      delete normalized.context1m;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeProviderSpecificData(
  provider: string | null | undefined,
  value: unknown
): JsonRecord | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;

  const normalized: JsonRecord = { ...record };

  if ("requestDefaults" in normalized) {
    const requestDefaults = normalizeRequestDefaults(provider, normalized.requestDefaults);
    if (requestDefaults) {
      normalized.requestDefaults = requestDefaults;
    } else {
      delete normalized.requestDefaults;
    }
  }

  if ("openaiStoreEnabled" in normalized && typeof normalized.openaiStoreEnabled !== "boolean") {
    delete normalized.openaiStoreEnabled;
  }

  if ("blockExtraUsage" in normalized && typeof normalized.blockExtraUsage !== "boolean") {
    delete normalized.blockExtraUsage;
  }

  if ("autoFetchModels" in normalized && typeof normalized.autoFetchModels !== "boolean") {
    delete normalized.autoFetchModels;
  }

  if ("tag" in normalized) {
    if (typeof normalized.tag === "string") {
      const trimmedTag = normalized.tag.trim();
      if (trimmedTag) {
        normalized.tag = trimmedTag;
      } else {
        delete normalized.tag;
      }
    } else {
      delete normalized.tag;
    }
  }

  if ("tags" in normalized) {
    const tags = normalizeRoutingTags(normalized.tags);
    if (tags.length > 0) {
      normalized.tags = tags;
    } else {
      delete normalized.tags;
    }
  }

  if ("excludedModels" in normalized || "excluded_models" in normalized) {
    const excludedModels = normalizeExcludedModelPatterns(
      normalized.excludedModels ?? normalized.excluded_models
    );
    if (excludedModels.length > 0) {
      normalized.excludedModels = excludedModels;
    } else {
      delete normalized.excludedModels;
    }
    delete normalized.excluded_models;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function sanitizeProviderSpecificDataForResponse(value: unknown): JsonRecord | undefined {
  const record = sanitizeProviderSpecificDataRecord(asRecord(value));
  if (Object.keys(record).length === 0) return undefined;

  return record;
}

function sanitizeProviderSpecificDataRecord(record: JsonRecord): JsonRecord {
  const sanitized: JsonRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    if (isSensitiveProviderSpecificDataKey(key)) continue;
    const sanitizedEntry = sanitizeProviderSpecificDataValue(entry);
    if (sanitizedEntry !== undefined) {
      sanitized[key] = sanitizedEntry;
    }
  }

  return sanitized;
}

function sanitizeProviderSpecificDataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProviderSpecificDataValue(entry));
  }

  if (value && typeof value === "object") {
    const sanitized = sanitizeProviderSpecificDataRecord(value as JsonRecord);
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  return value;
}

function isSensitiveProviderSpecificDataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!normalized) return false;

  if (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey")
  ) {
    return true;
  }

  return normalized === "key" || normalized.endsWith("key");
}

export function isOpenAIResponsesStoreEnabled(providerSpecificData: unknown): boolean {
  return asRecord(providerSpecificData).openaiStoreEnabled === true;
}

export function buildOpenAIStoreSessionId(sessionId: unknown): string | undefined {
  if (!hasNonEmptyString(sessionId)) return undefined;

  const normalized = String(sessionId)
    .trim()
    .replace(/^ext:/i, "")
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  if (!normalized) return undefined;
  return `omniroute-session-${normalized}`;
}

export function ensureOpenAIStoreSessionFallback(
  body: Record<string, unknown>,
  sessionId: unknown
): Record<string, unknown> {
  const explicitSessionId = body.session_id;
  const explicitConversationId = body.conversation_id;
  const promptCacheKey = body.prompt_cache_key ?? body.promptCacheKey;

  if (
    hasNonEmptyString(explicitSessionId) ||
    hasNonEmptyString(explicitConversationId) ||
    hasNonEmptyString(promptCacheKey)
  ) {
    return body;
  }

  const fallbackSessionId = buildOpenAIStoreSessionId(sessionId);
  if (!fallbackSessionId) return body;

  return {
    ...body,
    session_id: fallbackSessionId,
  };
}

export function getProviderRequestDefaults(
  provider: string | null | undefined,
  providerSpecificData: unknown
): JsonRecord {
  return normalizeRequestDefaults(provider, asRecord(providerSpecificData).requestDefaults) || {};
}

export function getCodexRequestDefaults(providerSpecificData: unknown): {
  reasoningEffort?: CodexReasoningEffort;
  serviceTier?: "priority";
} {
  const defaults = getProviderRequestDefaults("codex", providerSpecificData);
  const reasoningEffort = normalizeCodexReasoningEffort(defaults.reasoningEffort);
  const serviceTier = normalizeCodexServiceTier(defaults.serviceTier);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function getClaudeCodeCompatibleRequestDefaults(providerSpecificData: unknown): {
  context1m?: true;
} {
  const defaults = getProviderRequestDefaults(
    "anthropic-compatible-cc-default",
    providerSpecificData
  );
  const context1m = normalizeClaudeCodeCompatibleContext1m(defaults.context1m);
  return {
    ...(context1m ? { context1m } : {}),
  };
}
