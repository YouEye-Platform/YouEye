/**
 * App Manifest API
 *
 * GET — Fetch app manifest (from cache or live from container)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getApp,
  fetchAppManifest,
  updateAppManifest,
} from "@/lib/db/queries/app-management";

export async function GET(
  request: Request,
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
