/**
 * App Connections Discovery — GET /api/v1/my-connections
 *
 * Called by native apps (via Canvas getConnections()) to discover their
 * active bridges, internet access, and available backends.
 *
 * Auth: Authorization: Bearer <YOUEYE_APP_TOKEN> must match X-YouEye-App.
 * No user context needed — this is app-level, not user-level.
 *
 * Data source: `apps.connections` JSONB column, pushed by the Control Panel via
 * POST /api/ui-bridge/app-connections whenever bridge state changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateAppToken } from "@/lib/auth/app-token";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rawAppId = request.headers.get("x-youeye-app");
  if (!rawAppId) {
    return NextResponse.json(
      { error: "Missing X-YouEye-App header" },
      { status: 401 },
    );
  }

  // Accept "ye-search" or "search" — strip "ye-" prefix
  const appId = rawAppId.replace(/^ye-/, "");

  const tokenResult = await validateAppToken(request);
  if (!tokenResult) {
    return NextResponse.json(
      { error: "Invalid or missing app token" },
      { status: 401 },
    );
  }

  const tokenAppId = tokenResult.appId.replace(/^ye-/, "");
  if (tokenAppId !== appId && tokenResult.appId !== rawAppId) {
    return NextResponse.json(
      { error: "App token does not match X-YouEye-App" },
      { status: 403 },
    );
  }

  try {
    await ensureSchema();

    // Look up the app and its connections data
    let rows = await db
      .select({ id: apps.id, connections: apps.connections })
      .from(apps)
      .where(eq(apps.id, appId))
      .limit(1);

    // Try raw ID if stripped didn't match
    if (rows.length === 0 && appId !== rawAppId) {
      rows = await db
        .select({ id: apps.id, connections: apps.connections })
        .from(apps)
        .where(eq(apps.id, rawAppId))
        .limit(1);
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: `App "${rawAppId}" not registered` },
        { status: 403 },
      );
    }

    const connData = rows[0].connections as Record<string, unknown> | null;

    // Return the ConnectionStatus shape Canvas expects
    return NextResponse.json({
      bridges: (connData?.bridges as unknown[]) ?? [],
      internet: (connData?.internet as Record<string, unknown>) ?? {
        granted: false,
        hosts: [],
        blanket: false,
      },
      available: (connData?.available as unknown[]) ?? [],
    });
  } catch (err) {
    console.error("[my-connections] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
