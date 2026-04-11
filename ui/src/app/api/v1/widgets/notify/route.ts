/**
 * Widget Notify API
 *
 * POST — App notifies YE-UI that widget data has changed
 * Used by apps to trigger immediate refresh of their widgets
 */

import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();
  const { app_id, widget_id, event } = body;

  if (!app_id) {
    return NextResponse.json(
      { error: "app_id is required" },
      { status: 400 }
    );
  }

  // For now, acknowledge the notification
  // In future, this could trigger SSE/WebSocket push to connected clients
  console.log(
    `Widget notify: app=${app_id} widget=${widget_id ?? "all"} event=${event ?? "update"}`
  );

  return NextResponse.json({
    success: true,
    message: "Notification received",
  });
}
