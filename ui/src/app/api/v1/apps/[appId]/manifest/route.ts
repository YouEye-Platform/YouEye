/**
 * App Manifest API
 *
 * GET — Fetch app manifest (from cache or live from container)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { evaluateLocalAdmission } from '@/lib/admission/store';
import { authorizeCredentialBridge } from "@/lib/auth/app-credential-readiness";
import {
  getApp,
  fetchAppManifest,
  updateAppManifest,
} from "@/lib/db/queries/app-management";

function validateBridgeAuth(request: Request): boolean {
  return authorizeCredentialBridge(request, getBridgeToken());
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  if (!evaluateLocalAdmission(appId, session.identityId).allowed) {
    return NextResponse.json({ error: 'app_access_denied' }, { status: 403 });
  }
  const app = await getApp(appId);

  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "true";

  if (refresh && app.containerUrl) {
    const manifest = await fetchAppManifest(app.containerUrl);
    if (manifest) {
      await updateAppManifest(appId, manifest as unknown as Record<string, unknown>);
      return NextResponse.json(manifest);
    }
    return NextResponse.json(
      { error: "Failed to fetch manifest from app" },
      { status: 502 }
    );
  }

  if (app.manifest && Object.keys(app.manifest).length > 0) {
    return NextResponse.json(app.manifest);
  }

  if (app.containerUrl) {
    const manifest = await fetchAppManifest(app.containerUrl);
    if (manifest) {
      await updateAppManifest(appId, manifest as unknown as Record<string, unknown>);
      return NextResponse.json(manifest);
    }
  }

  return NextResponse.json(
    { error: "No manifest available" },
    { status: 404 }
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  if (!validateBridgeAuth(request)) {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: "Admin required" }, { status: 403 });
    }
  }

  const { appId } = await params;
  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const manifest = body?.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return NextResponse.json(
      { error: "manifest object is required" },
      { status: 400 }
    );
  }

  await updateAppManifest(appId, manifest as Record<string, unknown>);
  return NextResponse.json({
    success: true,
    app_id: appId,
    manifest_updated: true,
  });
}
