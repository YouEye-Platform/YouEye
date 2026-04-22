/**
 * GET /api/v1/connectors/resolve — Resolve which connector to use
 *
 * Query params:
 *   - capability: required (e.g., "search-engine")
 *   - app: required (requesting app ID, e.g., "ye-search")
 *
 * Auth: session cookie (browser) or X-YouEye-App + X-YouEye-User (service-to-service)
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveConnector } from "@/lib/db/queries/connectors";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const capability = url.searchParams.get("capability");
  const appId = url.searchParams.get("app");

  if (!capability || !appId) {
    return NextResponse.json(
      { error: "Missing required query params: capability, app" },
      { status: 400 }
    );
  }

  // Resolve user identity: session cookie first, then service-to-service headers
  let userId: string | null = null;

  const session = await getSession();
  if (session) {
    userId = session.userId;
  } else {
    const serviceUser = await resolveServiceAuth(request);
    if (serviceUser) {
      userId = serviceUser.id;
    }
  }

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const resolved = await resolveConnector(userId, capability, appId);

    if (!resolved) {
      const uiBaseUrl = process.env.UI_EXTERNAL_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
      return NextResponse.json({
        status: "not-connected",
        capability,
        setupUrl: `${uiBaseUrl}/connectors/setup?app=${encodeURIComponent(appId)}&capability=${encodeURIComponent(capability)}`,
      });
    }

    return NextResponse.json({
      status: resolved.autoWired ? "auto-connected" : "connected",
      ...resolved,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resolver error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
