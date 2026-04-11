/**
 * Timeline Collection API
 *
 * POST — Write a new encrypted timeline entry to a specific collection
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getActiveDerivedKey, hasPIN } from "@/lib/crypto/pin-session";
import { createTimelineEntry } from "@/lib/db/queries/timeline";
import type { TimelineEntryData } from "@/lib/db/queries/timeline";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ collection: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { collection } = await params;

  if (!["history", "future", "imported"].includes(collection)) {
    return NextResponse.json(
      { error: "Invalid collection. Must be: history, future, or imported" },
      { status: 400 }
    );
  }

  // Require active PIN session
  const pinExists = await hasPIN(session.userId);
  if (!pinExists) {
    return NextResponse.json(
      { error: "PIN not set up. Create a PIN first." },
      { status: 400 }
    );
  }

  const encryptionKey = await getActiveDerivedKey(session.userId);
  if (!encryptionKey) {
    return NextResponse.json(
      { error: "PIN session expired. Please verify your PIN." },
      { status: 403 }
    );
  }

  const body = await request.json();

  // Validate required fields
  const { entry_type, title, timestamp, app_id } = body;
  if (!entry_type || !title || !timestamp) {
    return NextResponse.json(
      { error: "entry_type, title, and timestamp are required" },
      { status: 400 }
    );
  }

  const entryData: TimelineEntryData = {
    app_id: app_id ?? "system",
    entry_type,
    title,
    timestamp,
    info_card: body.info_card ?? undefined,
    tags: body.tags ?? {},
    data: body.data ?? {},
    import_source: body.import_source,
    original_id: body.original_id,
    original_timestamp: body.original_timestamp,
  };

  const entryId = await createTimelineEntry(
    session.userId,
    collection as "history" | "future" | "imported",
    entryData,
    encryptionKey
  );

  return NextResponse.json({ id: entryId }, { status: 201 });
}
