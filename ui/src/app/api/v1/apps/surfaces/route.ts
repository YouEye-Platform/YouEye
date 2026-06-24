/**
 * App Surfaces API
 *
 * GET — List unified surface declarations from installed apps.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAppSurfaceDeclarations } from "@/lib/db/queries/app-management";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declarations = await getAppSurfaceDeclarations();

  return NextResponse.json({
    surfaces: declarations.flatMap((d) =>
      d.surfaces.map((surface) => ({
        id: `${d.appId}:${surface.id}`,
        app_id: d.appId,
        app_name: d.appName,
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
