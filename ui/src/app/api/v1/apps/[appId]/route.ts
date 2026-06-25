/**
 * App Details / Unregister API
 *
 * GET — Get app details including manifest
 * DELETE — Unregister app and clean up all related data
 * PUT — Update app details
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getApp,
  unregisterApp,
  updateAppStatus,
  checkAppHealth,
  fetchAppManifest,
  updateAppManifest,
  registerApp,
} from "@/lib/db/queries/app-management";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  const app = await getApp(appId);

  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: app.id,
    name: app.name,
    version: app.version,
    icon: app.icon,
    status: app.status,
    enabled: app.enabled,
    subdomain: app.subdomain,
    container_url: app.containerUrl,
    manifest: app.manifest,
    created_at: app.createdAt,
    updated_at: app.updatedAt,
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const { appId } = await params;
  const app = await getApp(appId);

  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  await unregisterApp(appId);

  return NextResponse.json({ success: true, app_id: appId });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const { appId } = await params;
  const app = await getApp(appId);

  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const body = await request.json();
  const { action } = body;

  if (action === "refresh-manifest" && app.containerUrl) {
    const manifest = await fetchAppManifest(app.containerUrl);
    if (manifest) {
      await updateAppManifest(appId, manifest as unknown as Record<string, unknown>);
      return NextResponse.json({ success: true, manifest });
    }
    return NextResponse.json(
      { error: "Failed to fetch manifest" },
      { status: 502 }
    );
  }

  if (action === "health-check" && app.containerUrl) {
    const health = await checkAppHealth(app.containerUrl);
    await updateAppStatus(
      appId,
      health.healthy ? "healthy" : "unhealthy"
    );
    return NextResponse.json({ success: true, ...health });
  }

  // Generic update
  if (body.name || body.container_url || body.icon || body.subdomain) {
    await registerApp({
      id: appId,
      name: body.name ?? app.name,
      containerUrl: body.container_url ?? app.containerUrl ?? "",
      subdomain: body.subdomain ?? app.subdomain,
      icon: body.icon ?? app.icon,
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "No valid action or fields" }, { status: 400 });
}
