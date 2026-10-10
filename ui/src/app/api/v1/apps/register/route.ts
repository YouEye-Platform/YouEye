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
  getApp,
  fetchAppManifest,
  updateAppManifest,
  unregisterApp,
} from "@/lib/db/queries/app-management";
import { getAllApps } from "@/lib/db/queries/apps";
import { evaluateLocalAdmission } from '@/lib/admission/store';
import { authorizeCredentialBridge } from "@/lib/auth/app-credential-readiness";
import { isCanonicalAppId } from "../../../../../../../shared/app-service-credential";

function validateBridgeAuth(request: Request): boolean {
  return authorizeCredentialBridge(request, getBridgeToken());
}

export async function POST(request: Request) {
  // Allow Control Panel bridge token auth for automated registration (server-to-server)
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
  const { id, name, container_url, subdomain, icon, sso_entry_url, link_handlers, manifest: cpManifest } = body;

  if (!isCanonicalAppId(id) || !name || !container_url) {
    return NextResponse.json(
      { error: "id, name, and container_url are required" },
      { status: 400 }
    );
  }

  // Try to fetch manifest from the app; fall back to the one CP sent
  const liveManifest = await fetchAppManifest(container_url);
  const existing = await getApp(id);
  const completeCpManifest = cpManifest && Object.keys(cpManifest).some(key => key !== 'integration') ? cpManifest : null;
  const manifest = liveManifest ?? completeCpManifest ?? existing?.manifest ?? cpManifest ?? null;
  if (manifest && isBridgeAuth && cpManifest?.integration === 'native') {
    Object.assign(manifest, { integration: 'native' });
  }

  await registerApp({
    id,
    name: manifest?.name ?? name,
    version: manifest?.version,
    containerUrl: container_url,
    subdomain,
    icon: manifest?.icon ?? icon,
    manifest: manifest ? (manifest as unknown as Record<string, unknown>) : undefined,
    ssoEntryUrl: sso_entry_url,
  });

  // Cache the manifest if we have one from either source. Merge in link_handlers from the Control Panel registration.
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
    apps: allApps.filter(a => evaluateLocalAdmission(a.id, session.identityId).allowed).map((a) => ({
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
