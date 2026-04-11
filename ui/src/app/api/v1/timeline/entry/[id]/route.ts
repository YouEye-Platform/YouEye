/**
 * Timeline Entry API
 *
 * PUT — Update a future timeline entry
 * DELETE — Delete a timeline entry
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getActiveDerivedKey } from "@/lib/crypto/pin-session";
import {
  deleteTimelineEntry,
  updateTimelineEntry,
} from "@/lib/db/queries/timeline";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const encryptionKey = await getActiveDerivedKey(session.userId);
  if (!encryptionKey) {
    return NextResponse.json(
      { error: "PIN session required" },
      { status: 403 }
    );
  }

  const body = await request.json();

  const success = await updateTimelineEntry(
    id,
    session.userId,
    body,
    encryptionKey
  );

  if (!success) {
    return NextResponse.json(
      { error: "Entry not found or not a future entry" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
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

  const success = await deleteTimelineEntry(id, session.userId);

  if (!success) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
