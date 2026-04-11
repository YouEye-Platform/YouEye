/**
 * Notifications API
 *
 * GET  /api/notifications — List user's notifications
 * POST /api/notifications — Create notification (system/app use)
 * PUT  /api/notifications — Mark all as read
 *
 * Authentication:
 * - Session cookie for browser requests
 * - X-YouEye-App + X-YouEye-User for service-to-service (Incus internal)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import {
  getUserNotifications,
  getUnreadCount,
  getNotificationCount,
  createNotification,
  markAllNotificationsRead,
  deleteReadNotifications,
} from "@/lib/db/queries/notifications";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

async function resolveUserId(request: NextRequest): Promise<string | null> {
  const session = await getSession();
  if (session) return session.userId;

  const serviceUser = await resolveServiceAuth(request);
  if (serviceUser) return serviceUser.id;

  return null;
}

export async function GET(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);
  const offset = parseInt(searchParams.get("offset") ?? "0");
  const type = searchParams.get("type") || undefined;
  const readParam = searchParams.get("read");
  const read = readParam === "true" ? true : readParam === "false" ? false : undefined;
  const search = searchParams.get("search") || undefined;

  const filters = { limit, offset, type, read, search };

  const [notifs, unreadCount, totalCount] = await Promise.all([
    getUserNotifications(userId, filters),
    getUnreadCount(userId),
    getNotificationCount(userId, { type, read, search }),
  ]);

  return NextResponse.json({
    notifications: notifs,
    unread_count: unreadCount,
    total: totalCount,
  });
}

/**
 * Validate bridge token from request headers.
 * Returns true if token is valid, false otherwise.
 */
function validateBridgeAuth(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

/**
 * Validate app-slug auth from native apps on the Incus internal network.
 * Native apps send X-App-Slug to identify themselves (trust boundary: Incus network).
 */
function validateAppSlugAuth(request: NextRequest): string | null {
  const slug = request.headers.get("X-App-Slug") ?? request.headers.get("x-app-slug");
  if (!slug) return null;
  // Accept any slug — trust boundary is Incus internal network
  return slug;
}

export async function POST(request: NextRequest) {
  // Support session auth, bridge token auth (CP→UI), or app-slug auth (native apps)
  const session = await getSession();
  const isBridgeAuth = validateBridgeAuth(request);
  const appSlug = validateAppSlugAuth(request);

  if (!session && !isBridgeAuth && !appSlug) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit inter-app notification ingest (skip for bridge auth — that's CP system calls)
  if (!isBridgeAuth) {
    const appSlug = request.headers.get("x-youeye-app") ?? "unknown";
    const rlResult = checkRateLimit(appSlug, "notifications", RATE_LIMITS.notifications);
    if (!rlResult.allowed) {
      const retryAfter = Math.ceil(rlResult.resetMs / 1000);
      return NextResponse.json(
        { error: "Too Many Requests", retry_after: retryAfter },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }
  }

  try {
    const body = await request.json();

    if (!body.title || typeof body.title !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'title'" },
        { status: 400 }
      );
    }

    // Bridge/app-slug auth requires explicit user_id; session auth defaults to current user
    const userId = body.user_id ?? session?.userId;
    if (!userId) {
      return NextResponse.json(
        { error: "Missing user_id for non-session-authenticated request" },
        { status: 400 }
      );
    }

    // Derive app_id from slug if provided via app-slug auth
    const appId = body.app_id ?? (appSlug ? `ye-${appSlug.replace("ye-", "")}` : undefined);

    const notif = await createNotification({
      userId,
      type: body.type ?? "info",
      title: body.title,
      message: body.message ?? body.body,
      appId,
      action: body.action ?? (body.actionUrl ? { type: "link", url: body.actionUrl } : undefined),
    });

    return NextResponse.json(notif, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Invalid notification data" },
      { status: 400 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await markAllNotificationsRead(userId);
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await deleteReadNotifications(userId);
  return NextResponse.json({ success: true });
}
