/**
 * App Gateway — Widget Sync
 *
 * POST /api/apps/v1/widgets/sync
 *
 * Apps publish their widget declarations to YE-UI.
 * Accepts both app tokens (Bearer) and bridge tokens (X-UI-Bridge-Token).
 * This endpoint replaces the old CP-hosted equivalent —
 * apps now talk to YE-UI directly instead of through CP.
 */

import { NextResponse } from "next/server";
import { validateAppToken } from "@/lib/auth/app-token";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { updateAppManifest, getApp } from "@/lib/db/queries/app-management";

function validateBridgeAuth(request: Request): boolean {
  const provided =
    request.headers.get("X-UI-Bridge-Token") ??
    request.headers.get("x-ui-bridge-token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function POST(request: Request) {
  let appId: string | null = null;

  const identity = await validateAppToken(request);
  if (identity) {
    appId = identity.appId;
  } else if (validateBridgeAuth(request)) {
    const url = new URL(request.url);
    appId = url.searchParams.get("appId");
  }

  if (!appId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "app not found" }, { status: 404 });
  }

  const widgetDeclarations = await request.json();

  const existingManifest = (app.manifest as Record<string, unknown>) ?? {};
  await updateAppManifest(appId, {
    ...existingManifest,
    widgets: widgetDeclarations,
  });

  return NextResponse.json({ ok: true });
}
