import { NextResponse } from "next/server";
import { getApiKeyUsageSummary, getFallbackTransparencyMetrics, getUsageDb } from "@/lib/usageDb";
import { computeAnalytics } from "@/lib/usageAnalytics";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUsageRangeStartIso, normalizeUsageRange } from "@/lib/usage/dateRanges";

const MAX_ANALYTICS_CHART_DAYS = 365;
const MAX_ANALYTICS_CHART_ROWS = 20000;

type ApiKeyUsageRow = {
  apiKey: string;
  apiKeyId: string | null;
  apiKeyName: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  firstUsed: string | null;
  lastUsed: string | null;
};

function getChartRangeStartIso(rangeStartIso: string | null): string {
  const boundedStart = new Date();
  boundedStart.setDate(boundedStart.getDate() - MAX_ANALYTICS_CHART_DAYS);

  if (!rangeStartIso) return boundedStart.toISOString();

  const rangeStart = new Date(rangeStartIso);
  if (Number.isNaN(rangeStart.getTime())) return boundedStart.toISOString();

  return rangeStart > boundedStart ? rangeStart.toISOString() : boundedStart.toISOString();
}

export async function GET(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const range = normalizeUsageRange(searchParams.get("range"));

    const rangeStartIso = getUsageRangeStartIso(range);
    // Keep raw chart data bounded; lifetime aggregates below are SQL-backed.
    const chartRangeStartIso = getChartRangeStartIso(rangeStartIso);
    const db = await getUsageDb(chartRangeStartIso, { maxRows: MAX_ANALYTICS_CHART_ROWS });
    const history = db.data.history || [];

    // Build connection map for account names
    const { getProviderConnections } = await import("@/lib/localDb");
    const connectionMap: Record<string, string> = {};
    try {
      const connections = await getProviderConnections();
      for (const connRaw of connections as unknown[]) {
        const conn =
          connRaw && typeof connRaw === "object" && !Array.isArray(connRaw)
            ? (connRaw as Record<string, unknown>)
            : {};
        const connectionId =
          typeof conn.id === "string" && conn.id.trim().length > 0 ? conn.id : null;
        if (!connectionId) continue;

        const name =
          (typeof conn.name === "string" && conn.name.trim()) ||
          (typeof conn.email === "string" && conn.email.trim()) ||
          connectionId;
        connectionMap[connectionId] = name;
      }
    } catch {
      /* ignore */
    }

    const analytics: any = await computeAnalytics(history, range, connectionMap);

    const byApiKeySummary = await getApiKeyUsageSummary({ sinceIso: rangeStartIso });
    const byApiKeyRows: ApiKeyUsageRow[] = Object.entries(byApiKeySummary)
      .map(([apiKey, stats]) => ({
        apiKey,
        apiKeyId: stats.apiKeyId,
        apiKeyName: stats.apiKeyName,
        requests: stats.requests,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        totalTokens: stats.totalTokens,
        cost: stats.cost,
        firstUsed: stats.firstUsed,
        lastUsed: stats.lastUsed,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    analytics.byApiKey = byApiKeyRows;
    analytics.summary.uniqueApiKeys = byApiKeyRows.length;
    analytics.meta = {
      ...(analytics.meta || {}),
      range,
      aggregatesSinceIso: rangeStartIso,
      chartSinceIso: chartRangeStartIso,
      chartMaxRows: MAX_ANALYTICS_CHART_ROWS,
      chartWindowDays: MAX_ANALYTICS_CHART_DAYS,
      chartDataBounded: range === "all",
    };

    // T01: fallback transparency metrics from call_logs (requested_model vs routed model).
    try {
      Object.assign(analytics.summary, getFallbackTransparencyMetrics({ sinceIso: rangeStartIso }));
    } catch {
      analytics.summary.fallbackCount = 0;
      analytics.summary.fallbackRatePct = 0;
      analytics.summary.requestedModelCoveragePct = 0;
    }

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("Error computing analytics:", error);
    return NextResponse.json({ error: "Failed to compute analytics" }, { status: 500 });
  }
}
