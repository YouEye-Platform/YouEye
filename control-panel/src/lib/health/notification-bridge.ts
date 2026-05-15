/**
 * Notification Bridge — CP → YE-UI notification delivery.
 *
 * Sends notification payloads to YE-UI's POST /api/v1/notifications endpoint
 * using the shared bridge token for authentication.
 *
 * YE-UI's notification API supports session cookies and service-to-service
 * auth via X-YouEye-App + X-YouEye-User headers. For system notifications
 * targeting all admins, we use the bridge approach: read all admin users
 * from YE-UI and create one notification per admin.
 */

import { readFile } from 'fs/promises';
import { getContainerIP } from '@/lib/incus/container-ip';

const TOKEN_FILE_PATH = '/etc/youeye/ui-bridge-token';
const UI_CONTAINER = 'youeye-ui';

/** Cached bridge token */
let cachedToken: string | null = null;
/** Cached UI IP */
let cachedUIIP: string | null = null;

async function getBridgeToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = (await readFile(TOKEN_FILE_PATH, 'utf-8')).trim();
    return cachedToken;
  } catch {
    throw new Error('Bridge token not available');
  }
}

async function getUIBaseUrl(): Promise<string> {
  if (!cachedUIIP) {
    cachedUIIP = await getContainerIP(UI_CONTAINER);
  }
  if (!cachedUIIP) {
    throw new Error('YE-UI container IP not available');
  }
  return `http://${cachedUIIP}:3000`;
}

export interface NotificationPayload {
  title: string;
  message?: string;
  type: 'info' | 'warning' | 'error' | 'success';
  source: 'system' | 'app';
  userId: string | null;
  actionUrl?: string;
  appId?: string;
}

interface UINotificationResult {
  success: boolean;
  created: number;
  errors: string[];
}

/**
 * Send a notification to YE-UI.
 *
 * If userId is null, fetches all admin users from YE-UI and creates
 * a notification for each one.
 */
export async function sendNotificationToUI(
  payload: NotificationPayload
): Promise<UINotificationResult> {
  const token = await getBridgeToken();
  const baseUrl = await getUIBaseUrl();
  const errors: string[] = [];
  let created = 0;

  // Build the action object if actionUrl is provided
  const action = payload.actionUrl
    ? { type: 'navigate', url: payload.actionUrl }
    : undefined;

  if (payload.userId) {
    // Single user notification
    try {
      await createNotificationInUI(baseUrl, token, {
        user_id: payload.userId,
        title: payload.title,
        message: payload.message,
        type: payload.type,
        app_id: payload.appId ?? (payload.source === 'system' ? 'system' : undefined),
        action,
      });
      created++;
    } catch (err) {
      errors.push(`User ${payload.userId}: ${err}`);
    }
  } else {
    // All admin users — fetch admin list from YE-UI
    const adminIds = await fetchAdminUserIds(baseUrl, token);
    if (adminIds.length === 0) {
      errors.push('No admin users found in YE-UI');
    }

    for (const adminId of adminIds) {
      try {
        await createNotificationInUI(baseUrl, token, {
          user_id: adminId,
          title: payload.title,
          message: payload.message,
          type: payload.type,
          app_id: payload.appId ?? (payload.source === 'system' ? 'system' : undefined),
          action,
        });
        created++;
      } catch (err) {
        errors.push(`Admin ${adminId}: ${err}`);
      }
    }
  }

  return { success: errors.length === 0, created, errors };
}

/**
 * Create a single notification via YE-UI's API.
 */
async function createNotificationInUI(
  baseUrl: string,
  token: string,
  data: {
    user_id: string;
    title: string;
    message?: string;
    type: string;
    app_id?: string;
    action?: Record<string, unknown>;
  }
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/notifications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-UI-Bridge-Token': token,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
}

/**
 * Fetch admin user IDs from YE-UI's users API.
 */
async function fetchAdminUserIds(baseUrl: string, token: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/users?role=admin`, {
      headers: {
        'X-UI-Bridge-Token': token,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    // Handle both array and object response formats
    const users = Array.isArray(data) ? data : data.users || [];
    return users
      .filter((u: { isAdmin?: boolean; is_admin?: boolean }) => u.isAdmin || u.is_admin)
      .map((u: { id: string }) => u.id);
  } catch {
    return [];
  }
}

/**
 * Clear cached UI IP (useful when container restarts).
 */
export function clearUIIPCache(): void {
  cachedUIIP = null;
}

/**
 * Clear cached bridge token.
 */
export function clearBridgeTokenCache(): void {
  cachedToken = null;
}
