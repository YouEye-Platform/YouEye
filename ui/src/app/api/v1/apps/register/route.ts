/**
 * App Registration API
 *
 * POST — Register a native app with YE-UI
 * GET — List all registered apps
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import {
  registerApp,
  fetchAppManifest,
  updateAppManifest,
  unregisterApp,
} from "@/lib/db/queries/app-management";
import { getAllApps } from "@/lib/db/queries/apps";

function validateBridgeAuth(request: Request): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token") ?? request.headers.get("x-ui-bridge-token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function POST(request: Request) {
  // Allow CP bridge token auth for automated registration (server-to-server)
  const isBridgeAuth = validateBridgeAuth(request);

  if (!isBridgeAuth) {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!session.isAdmin) {
      return NextResponse.json({ error: "Admin required" }, { status: 403 });
    }
  }

  const body = await request.json();
  const { id, name, container_url, subdomain, icon, token_hash, sso_entry_url, link_handlers } = body;

  if (!id || !name || !container_url) {
    return NextResponse.json(
      { error: "id, name, and container_url are required" },
      { status: 400 }
    );
  }

  // Try to fetch manifest from the app
  const manifest = await fetchAppManifest(container_url);

  await registerApp({
    id,
    name: manifest?.name ?? name,
    version: manifest?.version,
    containerUrl: container_url,
    subdomain,
    icon: manifest?.icon ?? icon,
    manifest: manifest ? (manifest as unknown as Record<string, unknown>) : undefined,
    tokenHash: token_hash,
    ssoEntryUrl: sso_entry_url,
  });

  // If manifest was fetched, cache it. Merge in link_handlers from CP registration.
  const manifestToStore = manifest
    ? (manifest as unknown as Record<string, unknown>)
    : {};
  if (Array.isArray(link_handlers) && link_handlers.length > 0) {
    manifestToStore.linkHandlers = link_handlers;
  }
  if (Object.keys(manifestToStore).length > 0) {
    await updateAppManifest(id, manifestToStore);
  }

  return NextResponse.json({
    success: true,
    app_id: id,
    manifest_fetched: !!manifest,
  });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allApps = await getAllApps();

  return NextResponse.json({
    apps: allApps.map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      icon: a.icon,
      status: a.status,
      enabled: a.enabled,
      subdomain: a.subdomain,
      container_url: a.containerUrl,
      has_manifest: !!a.manifest && Object.keys(a.manifest).length > 0,
    })),
  });
}
