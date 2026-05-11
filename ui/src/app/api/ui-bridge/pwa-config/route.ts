/**
 * UI Bridge: PWA Config Receiver
 *
 * PUT /api/ui-bridge/pwa-config
 * Body: { theme_color?, background_color?, maskable_bg_color?, display?, orientation? }
 *
 * Receives PWA configuration pushed from CP. Stores in system_settings
 * so the dynamic manifest can read it. One-way bridge: CP pushes, UI stores.
 *
 * Auth: X-UI-Bridge-Token (shared service token).
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { db, ensureSchema } from "@/db";
import { systemSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function PUT(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    await ensureSchema();

    const [existing] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "pwa_config"));

    if (existing) {
      await db
        .update(systemSettings)
        .set({ value: body, updatedAt: new Date() })
        .where(eq(systemSettings.key, "pwa_config"));
    } else {
      await db.insert(systemSettings).values({ key: "pwa_config", value: body });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[ui-bridge/pwa-config] Error:", err);
    return NextResponse.json(
      { error: "Failed to store PWA config" },
      { status: 500 }
    );
  }
}
