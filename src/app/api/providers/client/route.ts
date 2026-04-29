import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnections } from "@/lib/localDb";
import { sanitizeProviderSpecificDataForResponse } from "@/lib/providers/requestDefaults";

const SENSITIVE_PROVIDER_FIELDS = new Set(["accessToken", "refreshToken", "idToken", "apiKey"]);

function redactSensitiveProviderFields(connection: Record<string, unknown>) {
  const redacted = Object.fromEntries(
    Object.entries(connection).filter(([key]) => !SENSITIVE_PROVIDER_FIELDS.has(key))
  );

  redacted.providerSpecificData = sanitizeProviderSpecificDataForResponse(
    connection.providerSpecificData
  );
  return redacted;
}

// GET /api/providers/client - List provider connection metadata for authenticated clients.
// Raw credentials are intentionally excluded; sync/export paths must use dedicated tokens.
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const connections = await getProviderConnections();
    const clientConnections = connections.map((connection) =>
      redactSensitiveProviderFields(connection as Record<string, unknown>)
    );

    return NextResponse.json({ connections: clientConnections });
  } catch (error) {
    console.log("Error fetching providers for client:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
