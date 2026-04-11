/**
 * Notification Queries
 *
 * CRUD operations for user notifications.
 */

import { db, ensureSchema } from "@/db";
import { notifications } from "@/db/schema";
import { eq, and, desc, like, or, sql } from "drizzle-orm";

export interface NotificationFilters {
  limit?: number;
  offset?: number;
  type?: string;
  read?: boolean;
  search?: string;
}

export async function getUserNotifications(
  userId: string,
  filtersOrLimit: NotificationFilters | number = 20
) {
  await ensureSchema();

  const filters: NotificationFilters =
    typeof filtersOrLimit === "number"
      ? { limit: filtersOrLimit }
      : filtersOrLimit;

  const conditions = [eq(notifications.userId, userId)];

  if (filters.type) {
    conditions.push(eq(notifications.type, filters.type));
  }
  if (filters.read !== undefined) {
    conditions.push(eq(notifications.read, filters.read));
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        like(notifications.title, pattern),
        like(notifications.message, pattern)
      )!
    );
  }

  const query = db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);

  return query;
}

export async function getNotificationCount(
  userId: string,
  filters?: Omit<NotificationFilters, "limit" | "offset">
): Promise<number> {
  await ensureSchema();

  const conditions = [eq(notifications.userId, userId)];

  if (filters?.type) {
    conditions.push(eq(notifications.type, filters.type));
  }
  if (filters?.read !== undefined) {
    conditions.push(eq(notifications.read, filters.read));
  }
  if (filters?.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        like(notifications.title, pattern),
        like(notifications.message, pattern)
      )!
    );
  }

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(...conditions));

  return result[0]?.count ?? 0;
}

export async function getUnreadCount(userId: string): Promise<number> {
  await ensureSchema();
  const result = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return result.length;
}

export async function createNotification(data: {
  userId: string;
  type?: string;
  title: string;
  message?: string;
  appId?: string;
  action?: Record<string, unknown>;
}) {
  await ensureSchema();
  const [notif] = await db
    .insert(notifications)
    .values({
      userId: data.userId,
      type: data.type ?? "info",
      title: data.title,
      message: data.message ?? null,
      appId: data.appId ?? null,
      action: data.action ?? null,
    })
    .returning();
  return notif;
}

export async function markNotificationRead(notifId: string, userId: string) {
  await ensureSchema();
  const [updated] = await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, notifId), eq(notifications.userId, userId)))
    .returning();
  return updated;
}

export async function markAllNotificationsRead(userId: string) {
  await ensureSchema();
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}

export async function deleteNotification(notifId: string, userId: string) {
  await ensureSchema();
  await db
    .delete(notifications)
    .where(and(eq(notifications.id, notifId), eq(notifications.userId, userId)));
}

export async function deleteReadNotifications(userId: string) {
  await ensureSchema();
  await db
    .delete(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, true)));
}
