/**
 * Inter-App Communication Queries
 *
 * Manages webhook subscriptions and inter-app request logging.
 * All communication between apps goes through YE-UI as the gateway.
 */

import { db, ensureSchema } from "@/db";
import { webhookSubscriptions, interAppLog, apps } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { checkPermission } from "./permissions";

/** Register a webhook subscription */
export async function registerWebhook(
  subscriberAppId: string,
  event: string,
  endpoint: string
): Promise<string> {
  await ensureSchema();

  const [row] = await db
    .insert(webhookSubscriptions)
    .values({ subscriberAppId, event, endpoint })
    .returning({ id: webhookSubscriptions.id });

  return row.id;
}

/** Remove a webhook subscription by ID */
export async function removeWebhook(webhookId: string): Promise<void> {
  await ensureSchema();

  await db
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, webhookId));
}

/** Get all subscribers for an event */
export async function getEventSubscribers(
  event: string
): Promise<Array<{ subscriberAppId: string; endpoint: string }>> {
  await ensureSchema();

  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.event, event));

  return rows.map((r) => ({
    subscriberAppId: r.subscriberAppId,
    endpoint: r.endpoint,
  }));
}

/** Log an inter-app request */
export async function logInterAppRequest(
  userId: string,
  fromAppId: string,
  toAppId: string,
  requestType: string,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  await ensureSchema();

  await db.insert(interAppLog).values({
    userId,
    fromAppId,
    toAppId,
    requestType,
    success,
    errorMessage: errorMessage ?? null,
  });
}

/** Get inter-app request log */
export async function getInterAppLog(
  options: {
    userId?: string;
    appId?: string;
    limit?: number;
  } = {}
) {
  await ensureSchema();
  const { userId, appId, limit = 100 } = options;

  const conditions = [];
  if (userId) conditions.push(eq(interAppLog.userId, userId));
  if (appId) {
    // Match either direction
    conditions.push(eq(interAppLog.fromAppId, appId));
  }

  const query = db
    .select()
    .from(interAppLog)
    .orderBy(desc(interAppLog.createdAt))
    .limit(limit);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
}

/** Route an inter-app data request through the gateway */
export async function routeInterAppRequest(
  userId: string,
  fromAppId: string,
  toAppId: string,
  requestType: string,
  data: Record<string, unknown>
): Promise<{
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}> {
  // Check permission
  const hasPermission = await checkPermission(
    userId,
    fromAppId,
    "apps:request"
  );

  if (!hasPermission) {
    await logInterAppRequest(userId, fromAppId, toAppId, requestType, false, "PERMISSION_DENIED");

    return {
      success: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "User has not granted inter-app permission",
      },
    };
  }

  // Get target app info
  const [targetApp] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, toAppId))
    .limit(1);

  if (!targetApp) {
    await logInterAppRequest(userId, fromAppId, toAppId, requestType, false, "APP_NOT_FOUND");

    return {
      success: false,
      error: { code: "APP_NOT_FOUND", message: "Target app not installed" },
    };
  }

  if (!targetApp.containerUrl) {
    await logInterAppRequest(userId, fromAppId, toAppId, requestType, false, "APP_UNAVAILABLE");

    return {
      success: false,
      error: { code: "APP_UNAVAILABLE", message: "Target app not configured" },
    };
  }

  // Forward request to target app
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      `${targetApp.containerUrl}/api/inter-app/provide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requesting_app: fromAppId,
          request_type: requestType,
          data,
          user_id: userId,
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      await logInterAppRequest(userId, fromAppId, toAppId, requestType, false, errorText);

      return {
        success: false,
        error: {
          code: "APP_UNAVAILABLE",
          message: `Target app returned ${response.status}`,
        },
      };
    }

    const responseData = await response.json();

    await logInterAppRequest(userId, fromAppId, toAppId, requestType, true);

    return { success: true, data: responseData };
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Request failed";

    await logInterAppRequest(userId, fromAppId, toAppId, requestType, false, message);

    return {
      success: false,
      error: { code: "APP_UNAVAILABLE", message },
    };
  }
}
