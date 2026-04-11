/**
 * Admin App Edit API
 *
 * PUT /api/admin/apps/[appId] — Update global app properties (name, icon, subdomain)
 *
 * Changes here affect server-wide defaults visible to all users.
 * Subdomain changes trigger Caddy/Authentik reconfiguration via the CP bridge.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getApp, updateGlobalApp } from "@/lib/db/queries/app-management";
import { bridgeRequest } from "@/lib/admin/bridge-client";

export async function PUT(
  request: NextRequest,
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
  const body = await request.json();
  const { name, icon, subdomain } = body;

  // Validate app exists
  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  // If subdomain is changing, delegate to CP bridge for Caddy/Authentik/metadata update
  const subdomainChanged = subdomain && subdomain !== app.subdomain;
  if (subdomainChanged) {
    try {
      const bridgeRes = await bridgeRequest(
        "api/ui-bridge/apps/subdomain",
        {
          method: "PUT",
          body: JSON.stringify({
            appId,
            oldSubdomain: app.subdomain,
            newSubdomain: subdomain,
          }),
        }
      );

      if (!bridgeRes.ok) {
        const errText = await bridgeRes.text().catch(() => "Unknown error");
        return NextResponse.json(
          { error: `Subdomain change failed: ${errText}` },
          { status: 500 }
        );
      }
    } catch (err) {
      return NextResponse.json(
        { error: `Bridge error: ${err}` },
        { status: 502 }
      );
    }
  }

  // Update global app record
  const updated = await updateGlobalApp(appId, {
    name: name ?? undefined,
    icon: icon ?? undefined,
    subdomain: subdomain ?? undefined,
  });

  return NextResponse.json({ success: true, app: updated });
}
