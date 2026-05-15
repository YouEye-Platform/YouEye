/**
 * Single Notification API
 *
 * PUT    /api/notifications/[id] — Mark single notification as read
 * DELETE /api/notifications/[id] — Delete a notification
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  markNotificationRead,
  deleteNotification,
} from "@/lib/db/queries/notifications";

export async function PUT(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const updated = await markNotificationRead(id, session.userId);

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  await deleteNotification(id, session.userId);
  return NextResponse.json({ success: true });
}
