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

  // TODO: implement real-time push to connected clients (SSE/WebSocket)
  // For now, acknowledge the notification so apps don't get errors.
  // Widget data is still refreshed on the next client-side poll cycle.

  return NextResponse.json({
    success: true,
    message: "Notification received",
  });
}
