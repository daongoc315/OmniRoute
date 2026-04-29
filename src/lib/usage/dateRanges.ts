export type UsageRange = "1d" | "7d" | "30d" | "90d" | "ytd" | "all";

export function normalizeUsageRange(value: string | null | undefined): UsageRange {
  switch (value) {
    case "1d":
    case "7d":
    case "30d":
    case "90d":
    case "ytd":
    case "all":
      return value;
    default:
      return "30d";
  }
}

export function getUsageRangeStartIso(range: UsageRange): string | null {
  const end = new Date();
  const start = new Date(end);

  switch (range) {
    case "1d":
      start.setDate(start.getDate() - 1);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    case "90d":
      start.setDate(start.getDate() - 90);
      break;
    case "ytd":
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      break;
    case "all":
      return null;
  }

  return start.toISOString();
}

export function getSinceIsoFromSearchParams(searchParams: URLSearchParams): {
  range: UsageRange;
  sinceIso: string | null;
} {
  const since = searchParams.get("since");
  if (since) {
    const parsed = new Date(since);
    if (!Number.isNaN(parsed.getTime())) {
      return { range: "all", sinceIso: parsed.toISOString() };
    }
  }

  const range = normalizeUsageRange(searchParams.get("range"));
  return { range, sinceIso: getUsageRangeStartIso(range) };
}
