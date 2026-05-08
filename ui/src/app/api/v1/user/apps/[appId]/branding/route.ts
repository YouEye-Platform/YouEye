/**
 * User Per-App Branding API
 *
 * GET    /api/v1/user/apps/[appId]/branding — get resolved branding for app
 * PUT    /api/v1/user/apps/[appId]/branding — set user branding override
 * DELETE /api/v1/user/apps/[appId]/branding — remove user override (revert to admin default)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserAppsWithConfig, updateUserAppBranding } from "@/lib/db/queries/apps";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { appId } = await params;
  const { apps } = await getUserAppsWithConfig(session.userId);
  const app = apps.find((a) => a.id === appId);
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

  return NextResponse.json({
    appId,
    brandingWordart: app.brandingWordart,
    headerDisplayMode: app.headerDisplayMode,
    customName: app.customName,
    customIconUrl: app.customIconUrl,
    originalName: app.name,
    originalIcon: app.icon,
    adminBrandingWordart: app.adminBrandingWordart,
    adminHeaderDisplayMode: app.adminHeaderDisplayMode,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { appId } = await params;
  try {
    const body = await request.json();
    await updateUserAppBranding(session.userId, appId, {
      brandingWordart: body.brandingWordart,
      headerDisplayMode: body.headerDisplayMode,
      customName: body.customName,
      customIconUrl: body.customIconUrl,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { appId } = await params;
  await updateUserAppBranding(session.userId, appId, {
    brandingWordart: null,
    headerDisplayMode: null,
    customName: null,
    customIconUrl: null,
  });
  return NextResponse.json({ ok: true });
}
