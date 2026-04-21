/**
 * Widget Database Queries
 *
 * Functions for reading and saving the user's widget layout.
 * Each user has their own set of widgets with positions, sizes, and settings.
 */

import { eq } from "drizzle-orm";
import { db, ensureSchema } from "@/db";
import { widgets } from "@/db/schema";

/** Default widget layout for new users */
const DEFAULT_WIDGETS = [
  {
    widgetType: "server-name",
    positionX: 28,
    positionY: 22,
    width: 44,
    height: 10,
    settings: {},
    order: 0,
  },
  {
    widgetType: "search",
    positionX: 30,
    positionY: 42,
    width: 40,
    height: 10,
    settings: {},
    order: 1,
  },
  {
    widgetType: "clock",
    positionX: 80,
    positionY: 5,
    width: 14,
    height: 10,
    settings: {},
    order: 2,
  },
];

/** Widget data shape returned to the client */
export interface WidgetData {
  id: string;
  widgetType: string;
  appId: string | null;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  settings: Record<string, unknown>;
  order: number;
}

/** Get all widgets for a user. Returns defaults if user has none. */
export async function getUserWidgets(userId: string): Promise<WidgetData[]> {
  await ensureSchema();
  const userWidgets = await db
    .select()
    .from(widgets)
    .where(eq(widgets.userId, userId));

  if (userWidgets.length === 0) {
    // Create default widgets for new user
    const created = await db
      .insert(widgets)
      .values(
        DEFAULT_WIDGETS.map((w) => ({
          userId,
          ...w,
        }))
      )
      .returning();

    return created.map(toWidgetData);
  }

  return userWidgets.map(toWidgetData);
}

/** Save (replace) all widgets for a user */
export async function saveUserWidgets(
  userId: string,
  widgetData: Array<{
    widgetType: string;
    appId?: string | null;
    positionX: number;
    positionY: number;
    width: number;
    height: number;
    settings?: Record<string, unknown>;
    order?: number;
  }>
): Promise<WidgetData[]> {
  await ensureSchema();
  // Delete all existing widgets for user
  await db.delete(widgets).where(eq(widgets.userId, userId));

  if (widgetData.length === 0) return [];

  // Insert new widgets
  const created = await db
    .insert(widgets)
    .values(
      widgetData.map((w, i) => ({
        userId,
        widgetType: w.widgetType,
        appId: w.appId ?? null,
        positionX: w.positionX,
        positionY: w.positionY,
        width: w.width,
        height: w.height,
        settings: w.settings ?? {},
        order: w.order ?? i,
      }))
    )
    .returning();

  return created.map(toWidgetData);
}

/** Map a database widget row to the client-facing shape */
function toWidgetData(row: typeof widgets.$inferSelect): WidgetData {
  return {
    id: row.id,
    widgetType: row.widgetType,
    appId: row.appId,
    positionX: row.positionX,
    positionY: row.positionY,
    width: row.width,
    height: row.height,
    settings: (row.settings as Record<string, unknown>) ?? {},
    order: row.order ?? 0,
  };
}
