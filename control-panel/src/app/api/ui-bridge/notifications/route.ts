/**
 * UI Bridge: Notifications
 *
 * POST /api/ui-bridge/notifications — Create notification in YE-UI
 *
 * Accepts a notification payload and forwards it to YE-UI's notification
 * creation endpoint via the bridge token auth pattern.
 *
 * Payload:
 *   { title, message, type: 'info'|'warning'|'error', source: 'system'|'app',
 *     userId?: string, actionUrl?: string }
 *
 * If userId is null/omitted, the notification is created for all admin users.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';

export const dynamic = 'force-dynamic';

interface NotificationPayload {
  title: string;
  message?: string;
  type?: 'info' | 'warning' | 'error' | 'success';
  source?: 'system' | 'app';
  userId?: string | null;
  actionUrl?: string;
  appId?: string;
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body: NotificationPayload = await request.json();

    if (!body.title || typeof body.title !== 'string') {
      return NextResponse.json(
        { error: "Missing or invalid 'title'" },
        { status: 400 }
      );
    }

    const result = await sendNotificationToUI({
      title: body.title,
      message: body.message,
      type: body.type ?? 'info',
      source: body.source ?? 'system',
      userId: body.userId ?? null,
      actionUrl: body.actionUrl,
      appId: body.appId,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error('[UI Bridge] Notification creation error:', err);
    return NextResponse.json(
      { error: `Failed to create notification: ${err}` },
      { status: 500 }
    );
  }
}
