/**
 * Widget Database Queries
 *
 * Functions for reading and saving the user's widget layout.
 * Each user has their own set of widgets with positions, sizes, and settings.
 */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, ensureSchema } from "@/db";
import { widgets } from "@/db/schema";

/** Default widget layout for new users */
const DEFAULT_WIDGETS = [
  {
    widgetType: "server-name",
    positionX: 40,
    positionY: 18,
    width: 15,
    height: 4,
    settings: {},
    order: 0,
  },
  {
    widgetType: "greeting",
    positionX: 30,
    positionY: 32,
    width: 35,
    height: 8,
    settings: {},
    order: 1,
  },
  {
    widgetType: "clock",
    positionX: 82,
    positionY: 5,
    width: 14,
    height: 6,
    settings: {},
    order: 2,
  },
  {
    widgetType: "bookmarks",
    positionX: 25,
    positionY: 80,
    width: 45,
    height: 14,
    settings: {},
    order: 3,
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

const widgetLayoutSchema = z.array(z.object({
  widgetType: z.string().min(1),
  appId: z.string().nullable().optional(),
  positionX: z.number().finite(),
  positionY: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  settings: z.record(z.string(), z.unknown()).optional(),
  order: z.number().int().optional(),
}));

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
  // Validate the complete replacement before touching the saved layout.
  const replacement = widgetLayoutSchema.parse(widgetData);
  await ensureSchema();
  return db.transaction(async (tx) => {
    // Serialize replacements even when this account currently has no rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`youeye:widgets:${userId}`}, 0))`);
    await tx.delete(widgets).where(eq(widgets.userId, userId));
    if (replacement.length === 0) return [];

    const created = await tx.insert(widgets).values(
      replacement.map((w, i) => ({
        userId,
        widgetType: w.widgetType,
        appId: w.appId ?? null,
        positionX: w.positionX,
        positionY: w.positionY,
        width: w.width,
        height: w.height,
        settings: w.settings ?? {},
        order: w.order ?? i,
      })),
    ).returning();
    return created.map(toWidgetData);
  });
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
