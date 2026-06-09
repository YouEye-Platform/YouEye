/**
 * App Widgets API
 *
 * GET — List all widget declarations from installed apps
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
    widgets: declarations.flatMap((d) =>
      d.surfaces
        .filter((surface) => surface.kind === "widget" && surface.placement === "dashboard")
        .map((w) => ({
        id: `${d.appId}:${w.id}`,
        app_id: d.appId,
        app_name: d.appName,
        widget_id: w.id,
        name: w.name ?? w.id,
        description: w.description,
        embed_path: w.embedPath,
        permissions: w.permissions,
        default_size: w.defaultSize,
        min_size: w.minSize,
        max_size: w.maxSize,
        refresh_interval: w.refreshInterval,
        settings_schema: w.settingsSchema,
      }))
    ),
  });
}
