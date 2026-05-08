/**
 * Admin Per-App Branding API
 *
 * GET /api/v1/admin/apps/[appId]/branding — get admin default branding
 * PUT /api/v1/admin/apps/[appId]/branding — set admin default branding
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { updateAppBranding } from "@/lib/db/queries/apps";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { appId } = await params;
  const [app] = await db.select().from(apps).where(eq(apps.id, appId));
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

  return NextResponse.json({
    appId,
    brandingWordart: app.brandingWordart ?? null,
    headerDisplayMode: app.headerDisplayMode ?? "logo-text",
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { appId } = await params;
  try {
    const body = await request.json();
    const row = await updateAppBranding(appId, {
      brandingWordart: body.brandingWordart,
      headerDisplayMode: body.headerDisplayMode,
    });
    if (!row) return NextResponse.json({ error: "App not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
