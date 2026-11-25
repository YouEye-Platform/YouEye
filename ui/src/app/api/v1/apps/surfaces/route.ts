/**
 * App Surfaces API
 *
 * GET — List unified surface declarations from installed apps.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getAppSurfaceDeclarations } from "@/lib/db/queries/app-management";
import { evaluateUiUserAdmission } from '@/lib/admission/store';
import { publicAppUrl, publicBaseDomain } from "@/lib/surfaces/app-url";

export async function GET(request: NextRequest) {
  const session = await getSession();
  const service = !session ? await resolveServiceAuth(request) : null;
  if (!session && !service) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declarations = await getAppSurfaceDeclarations();
  const decisions = await Promise.all(declarations.map(d =>
    evaluateUiUserAdmission(d.appId, (session?.userId ?? service?.id)!)));
  const admitted = declarations.filter((_, i) => decisions[i].allowed);
  const baseDomain = publicBaseDomain(request.headers.get("host"), !!service);

  return NextResponse.json({
    surfaces: admitted.flatMap((d) =>
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
