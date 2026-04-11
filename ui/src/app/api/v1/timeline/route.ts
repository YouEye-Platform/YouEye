/**
 * Timeline API
 *
 * GET — Read + decrypt + filter timeline entries
 * POST — Ingest timeline events from native apps (requires timeline:write permission)
 *
 * Query params for GET: collection, limit, offset, app, entry_type, tag, from, to, sort
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getActiveDerivedKey, hasPIN } from "@/lib/crypto/pin-session";
import {
  getTimelineEntries,
  getTimelineCounts,
  createTimelineEntry,
  queuePendingEvent,
  processPendingEvents,
} from "@/lib/db/queries/timeline";
import type { TimelineEntryData } from "@/lib/db/queries/timeline";
import { checkPermission, grantPermission } from "@/lib/db/queries/permissions";

/** Native app IDs that are auto-granted timeline:write */
const NATIVE_APP_IDS = ["ye-wiki", "ye-search", "ye-notes", "ye-cinema", "ye-weather", "ye-translate"];

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const collection = url.searchParams.get("collection") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const app = url.searchParams.get("app") ?? undefined;
  const entryType = url.searchParams.get("entry_type") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const sort =
    (url.searchParams.get("sort") as "asc" | "desc") ?? "desc";

  // Check if user has PIN set up
  const pinExists = await hasPIN(session.userId);
  if (!pinExists) {
    const counts = await getTimelineCounts(session.userId);
    return NextResponse.json({
      entries: [],
      total: 0,
      counts,
      pin_required: true,
      pin_exists: false,
    });
  }

  // Get encryption key from active session
  const encryptionKey = await getActiveDerivedKey(session.userId);
  if (!encryptionKey) {
    const counts = await getTimelineCounts(session.userId);
    return NextResponse.json({
      entries: [],
      total: 0,
      counts,
      pin_required: true,
      pin_exists: true,
    });
  }

  // Process any pending events before returning entries
  try {
    await processPendingEvents(session.userId, encryptionKey);
  } catch {
    // Non-critical — don't fail the main query
  }

  const { entries, total } = await getTimelineEntries(
    session.userId,
    encryptionKey,
    { collection, limit, offset, app, entryType, tag, from, to, sort }
  );

  const counts = await getTimelineCounts(session.userId);

  return NextResponse.json({
    entries,
    total,
    counts,
    pin_required: false,
    pin_exists: true,
    limit,
    offset,
  });
}

/**
 * POST — Ingest a timeline event from a native app.
 *
 * Requires X-YouEye-App and X-YouEye-User headers (service-to-service auth).
 * Checks timeline:write permission. Auto-grants for native apps.
 *
 * If the user has an active PIN session, encrypts immediately.
 * Otherwise, queues the event for encryption on next PIN unlock.
 */
export async function POST(request: NextRequest) {
  // Try service auth first (app-to-app)
  const serviceUser = await resolveServiceAuth(request);
  const appId = request.headers.get("x-youeye-app");

  let userId: string;

  if (serviceUser && appId) {
    userId = serviceUser.id;

    // Auto-grant timeline:write for native apps
    if (NATIVE_APP_IDS.includes(appId)) {
      const hasPermission = await checkPermission(
        userId,
        appId,
        "timeline:write"
      );
      if (!hasPermission) {
        await grantPermission(
          userId,
          appId,
          "timeline:write",
          "persistent",
          "system"
        );
      }
    } else {
      // Check permission for third-party apps
      const hasPermission = await checkPermission(
        userId,
        appId,
        "timeline:write"
      );
      if (!hasPermission) {
        return NextResponse.json(
          { error: "Permission denied: timeline:write required" },
          { status: 403 }
        );
      }
    }
  } else {
    // Fall back to session auth (user creating entries directly)
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = session.userId;
  }

  const body = await request.json();

  // Validate required fields
  const { entry_type, title, app_id } = body;
  if (!entry_type || !title) {
    return NextResponse.json(
      { error: "entry_type and title are required" },
      { status: 400 }
    );
  }

  const collection = body.collection ?? "history";
  if (!["history", "future", "imported"].includes(collection)) {
    return NextResponse.json(
      { error: "Invalid collection" },
      { status: 400 }
    );
  }

  const effectiveAppId = app_id ?? appId ?? "system";
  const timestamp = body.timestamp ?? new Date().toISOString();

  // Try to encrypt immediately if PIN session is active
  const pinExists = await hasPIN(userId);
  if (pinExists) {
    const encryptionKey = await getActiveDerivedKey(userId);
    if (encryptionKey) {
      // Encrypt and store directly
      const entryData: TimelineEntryData = {
        app_id: effectiveAppId,
        entry_type,
        title,
        timestamp,
        info_card: body.info_card ?? undefined,
        tags: body.tags ?? {},
        data: body.data ?? {},
      };

      const entryId = await createTimelineEntry(
        userId,
        collection as "history" | "future" | "imported",
        entryData,
        encryptionKey
      );

      return NextResponse.json({ id: entryId, queued: false }, { status: 201 });
    }
  }

  // No active PIN session — queue for later encryption
  const payload = {
    entry_type,
    title,
    timestamp,
    info_card: body.info_card ?? undefined,
    tags: body.tags ?? {},
    data: body.data ?? {},
  };

  const pendingId = await queuePendingEvent(
    userId,
    effectiveAppId,
    collection,
    payload
  );

  return NextResponse.json(
    { id: pendingId, queued: true },
    { status: 202 }
  );
}
