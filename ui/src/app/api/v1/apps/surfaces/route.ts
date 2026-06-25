/**
 * App Surfaces API
 *
 * GET — List unified surface declarations from installed apps.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getAppSurfaceDeclarations } from "@/lib/db/queries/app-management";

function publicBaseDomain(request: NextRequest, isServiceCall: boolean): string {
  const uiExternalUrl = process.env.UI_EXTERNAL_URL || process.env.BASE_URL || process.env.NEXTAUTH_URL || "";
  if (isServiceCall && uiExternalUrl) {
    try {
      return new URL(uiExternalUrl).hostname;
    } catch {
      // Fall through to the request host below.
    }
  }
  return (request.headers.get("host") ?? "").replace(/:\d+$/, "");
}

function publicAppUrl(
  declaration: { subdomain: string | null; containerUrl: string | null },
  baseDomain: string
): string | null {
  if (declaration.subdomain && baseDomain) return `https://${declaration.subdomain}.${baseDomain}`;
  return declaration.containerUrl;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const service = !session ? await resolveServiceAuth(request) : null;
  if (!session && !service) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declarations = await getAppSurfaceDeclarations();
  const baseDomain = publicBaseDomain(request, !!service);

  return NextResponse.json({
    surfaces: declarations.flatMap((d) =>
      d.surfaces.map((surface) => ({
        id: `${d.appId}:${surface.id}`,
        app_id: d.appId,
        app_name: d.appName,
        app_url: publicAppUrl(d, baseDomain),
        icon: d.icon,
        surface_id: surface.id,
        kind: surface.kind,
        placement: surface.placement,
        name: surface.name ?? surface.id,
        description: surface.description,
        embed_path: surface.embedPath,
        permissions: surface.permissions,
        default_size: surface.defaultSize,
        min_size: surface.minSize,
        max_size: surface.maxSize,
        refresh_interval: surface.refreshInterval,
        settings_schema: surface.settingsSchema,
        triggers: surface.triggers,
      }))
    ),
  });
}
