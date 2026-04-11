/**
 * App Widgets API
 *
 * GET — List all widget declarations from installed apps
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAppWidgetDeclarations } from "@/lib/db/queries/app-management";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declarations = await getAppWidgetDeclarations();

  return NextResponse.json({
    widgets: declarations.flatMap((d) =>
      d.widgets.map((w) => ({
        id: `${d.appId}:${w.id}`,
        app_id: d.appId,
        app_name: d.appName,
        widget_id: w.id,
        name: w.name,
        description: w.description,
        default_size: w.default_size,
        min_size: w.min_size,
        max_size: w.max_size,
        refresh_interval: w.refresh_interval,
        settings_schema: w.settings_schema,
      }))
    ),
  });
}
