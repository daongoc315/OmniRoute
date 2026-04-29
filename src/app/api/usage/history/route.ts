import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

function parseClampedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  const integer = Number.isInteger(parsed) ? parsed : fallback;
  return Math.min(Math.max(integer, min), max);
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const days = parseClampedInteger(searchParams.get("days"), 30, 1, 365);
    const maxRows = parseClampedInteger(searchParams.get("limit"), 20000, 1, 20000);
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stats = await getUsageStats({ sinceIso, maxRows });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
