/**
 * Drawer Preferences API
 *
 * GET  /api/v1/apps/drawer/prefs — Get user's drawer layout preferences
 * PUT  /api/v1/apps/drawer/prefs — Save drawer layout preferences
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDrawerPrefs, saveDrawerPrefs } from "@/lib/db/queries/settings";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prefs = await getDrawerPrefs(session.userId);
  return NextResponse.json(prefs);
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    await saveDrawerPrefs(session.userId, {
      columns: typeof body.columns === "number" ? Math.min(Math.max(body.columns, 2), 6) : undefined,
      iconScale: typeof body.iconScale === "number" ? Math.min(Math.max(body.iconScale, 0.5), 2) : undefined,
      maxHeight: typeof body.maxHeight === "number" ? Math.min(Math.max(body.maxHeight, 200), 800) : undefined,
    });

    const prefs = await getDrawerPrefs(session.userId);
    return NextResponse.json(prefs);
  } catch {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
}
