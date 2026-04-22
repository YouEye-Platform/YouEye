/**
 * GET /api/v1/connectors/backends — Discover installed app backends for connectors
 *
 * Query params:
 *   - connectorId: specific connector to check (optional)
 *   - capability: discover backends for all connectors providing this capability (optional)
 *   At least one must be provided.
 *
 * Auth: session cookie or X-YouEye-App + X-YouEye-User headers
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import {
  discoverBackends,
  discoverBackendsByCapability,
} from "@/lib/db/queries/connectors";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const connectorId = url.searchParams.get("connectorId");
  const capability = url.searchParams.get("capability");

  if (!connectorId && !capability) {
    return NextResponse.json(
      { error: "Provide connectorId or capability query param" },
      { status: 400 }
    );
  }

  // Auth check
  const session = await getSession();
  let authed = !!session;
  if (!authed) {
    const serviceUser = await resolveServiceAuth(request);
    authed = !!serviceUser;
  }
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (connectorId) {
      const backends = await discoverBackends(connectorId);
      return NextResponse.json({ connectorId, backends });
    }

    // capability query
    const results = await discoverBackendsByCapability(capability!);
    return NextResponse.json({ capability, connectors: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backend discovery error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
