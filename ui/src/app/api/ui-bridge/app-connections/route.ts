/**
 * UI Bridge — App Connections push endpoint.
 *
 * POST /api/ui-bridge/app-connections
 *
 * Called by the Control Panel whenever bridge state changes (activate/deactivate/create/delete).
 * Stores connection data in the apps table so /api/v1/my-connections can serve it
 * without calling CP (UI cannot call CP — one-way bridge).
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function POST(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { appId, bridges, internet } = body;

    if (!appId || typeof appId !== "string") {
      return NextResponse.json({ error: "Missing appId" }, { status: 400 });
    }

    const connectionData = {
      bridges: bridges ?? [],
      internet: internet ?? { granted: false, hosts: [] },
      updatedAt: new Date().toISOString(),
    };

    // Update the connections column on the app row
    const result = await db
      .update(apps)
      .set({ connections: connectionData as Record<string, unknown> })
      .where(eq(apps.id, appId))
      .returning({ id: apps.id });

    if (result.length === 0) {
      return NextResponse.json(
        { error: `App "${appId}" not found in UI database` },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, appId });
  } catch (err) {
    console.error("[ui-bridge/app-connections] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
