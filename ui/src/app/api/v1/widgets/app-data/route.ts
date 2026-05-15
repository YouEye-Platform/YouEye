/**
 * Widget App Data Proxy
 *
 * GET — Proxy widget data requests to app's widget endpoint
 * Query params: app (appId), widget (widgetId)
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getApp } from "@/lib/db/queries/app-management";
import type { AppManifest } from "@/lib/db/queries/app-management";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const appId = url.searchParams.get("app");
  const widgetId = url.searchParams.get("widget");

  if (!appId || !widgetId) {
    return NextResponse.json(
      { error: "app and widget query params required" },
      { status: 400 }
    );
  }

  const app = await getApp(appId);
  if (!app || !app.containerUrl) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  // Look up the widget's data endpoint from manifest
  const manifest = app.manifest as AppManifest | null;
  const widgetDecl = manifest?.widgets?.find((w) => w.id === widgetId);

  // Default endpoint pattern: /api/widgets/{widgetId}/data
  const endpoint = `/api/widgets/${widgetId}/data`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`${app.containerUrl}${endpoint}`, {
      headers: {
        "X-YouEye-User": session.authentikId ?? session.userId,
        "X-YouEye-Username": session.username,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(
        { error: `App returned ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();

    return NextResponse.json({
      ...data,
      _meta: {
        app_id: appId,
        widget_id: widgetId,
        refresh_interval: widgetDecl?.refresh_interval ?? 300,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch widget data" },
      { status: 502 }
    );
  }
}
