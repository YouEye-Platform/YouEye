/**
 * Notifications API
 *
 * GET  /api/notifications — List user's notifications
 * POST /api/notifications — Create notification (system/app use)
 * PUT  /api/notifications — Mark all as read
 *
 * Inbox management requires a platform browser session. App services may
 * send to their admitted acting user with notifications:send permission;
 * that permission does not expose the user's other applications' messages.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { checkPermission } from '@/lib/db/queries/permissions';
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { authorizeCredentialBridge } from "@/lib/auth/app-credential-readiness";
import {
  getUserNotifications,
  getUnreadCount,
  getNotificationCount,
  createNotification,
  markAllNotificationsRead,
  deleteReadNotifications,
} from "@/lib/db/queries/notifications";
import { getNotificationSurfaceMap, getAppMetaMap } from "@/lib/db/queries/app-management";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

async function resolveInboxUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.userId ?? null;
}

export async function GET(request: NextRequest) {
  const userId = await resolveInboxUserId();
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

  const [notifs, unreadCount, totalCount, notificationSurfaces, appMeta] = await Promise.all([
    getUserNotifications(userId, filters),
    getUnreadCount(userId),
    getNotificationCount(userId, { type, read, search }),
    getNotificationSurfaceMap(),
    // E3: app icon/accent/name for the per-notification `.via` attribution chip
    // (same source the timeline feed uses — anti-impersonation: UI-rendered, not app-supplied).
    getAppMetaMap(),
  ]);
  const notifications = notifs.map((notif) => {
    const appId = notif.appId;
    const surface = appId
      ? notificationSurfaces[appId] ?? notificationSurfaces[appId.replace(/^ye-/, "")]
      : undefined;
    return surface
      ? {
          ...notif,
          surface,
        }
      : notif;
  });

  return NextResponse.json({
    notifications,
    unread_count: unreadCount,
    total: totalCount,
    notification_surfaces: notificationSurfaces,
    app_meta: appMeta,
  });
}

/**
 * Validate bridge token from request headers.
 * Returns true if token is valid, false otherwise.
 */
function validateBridgeAuth(request: NextRequest): boolean {
  return authorizeCredentialBridge(request, getBridgeToken());
}

export async function POST(request: NextRequest) {
  // Support session auth, bridge token auth (Control Panel→UI), or service auth (native apps with token)
  let session: Awaited<ReturnType<typeof getSession>> = null;
  try {
    session = await getSession();
  } catch {
    // getSession() throws if JWT_SECRET is not configured — that's fine for
    // non-session auth paths (bridge token, service auth)
  }
  const isBridgeAuth = validateBridgeAuth(request);
  if (request.headers.has("x-ui-bridge-token")
    && (!isBridgeAuth || request.headers.has("authorization")
      || request.headers.has("x-youeye-app") || request.headers.has("x-youeye-user"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const serviceUser = !session && !isBridgeAuth
    ? await resolveServiceAuth(request)
    : null;

  if (!session && !isBridgeAuth && !serviceUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actingApp = serviceUser ? request.headers.get('x-youeye-app') : session?.actingAppId;
  if (actingApp && !await checkPermission((serviceUser?.id || session?.userId)!, actingApp, 'notifications:send')) {
    return NextResponse.json({ error: 'notifications:send permission required' }, { status: 403 });
  }

  // Rate limit inter-app notification ingest (skip for bridge auth — that's Control Panel system calls)
  if (!isBridgeAuth && !session) {
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

    if (serviceUser && (
      (body.user_id !== undefined && body.user_id !== serviceUser.id && body.user_id !== serviceUser.identityId)
      || (body.app_id !== undefined && body.app_id !== serviceUser.appId)
    )) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (session && body.user_id !== undefined && body.user_id !== session.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const userId = serviceUser?.id ?? session?.userId ?? body.user_id;
    if (!userId) {
      return NextResponse.json(
        { error: "Missing user_id for non-session-authenticated request" },
        { status: 400 }
      );
    }

    const appId = serviceUser?.appId ?? body.app_id;

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

export async function PUT() {
  const userId = await resolveInboxUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await markAllNotificationsRead(userId);
  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const userId = await resolveInboxUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await deleteReadNotifications(userId);
  return NextResponse.json({ success: true });
}
