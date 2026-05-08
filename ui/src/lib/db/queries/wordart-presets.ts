import { eq, and, or, desc, isNull } from "drizzle-orm";
import { db, ensureSchema } from "@/db";
import { wordartPresets } from "@/db/schema";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

export interface WordArtPreset {
  id: string;
  userId: string | null;
  name: string;
  style: SiteNameStyle;
  scope: string;
  appId: string | null;
  createdAt: Date | null;
}

function rowToPreset(row: typeof wordartPresets.$inferSelect): WordArtPreset {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    style: row.style as unknown as SiteNameStyle,
    scope: row.scope,
    appId: row.appId ?? null,
    createdAt: row.createdAt,
  };
}

export async function getUserPresets(userId: string): Promise<WordArtPreset[]> {
  await ensureSchema();
  const rows = await db
    .select()
    .from(wordartPresets)
    .where(and(eq(wordartPresets.userId, userId), eq(wordartPresets.scope, "user"), isNull(wordartPresets.appId)))
    .orderBy(desc(wordartPresets.createdAt));
  return rows.map(rowToPreset);
}

export async function getServerPresets(): Promise<WordArtPreset[]> {
  await ensureSchema();
  const rows = await db
    .select()
    .from(wordartPresets)
    .where(and(eq(wordartPresets.scope, "server"), isNull(wordartPresets.appId)))
    .orderBy(desc(wordartPresets.createdAt));
  return rows.map(rowToPreset);
}

export async function getAllPresetsForUser(userId: string): Promise<WordArtPreset[]> {
  await ensureSchema();
  const rows = await db
    .select()
    .from(wordartPresets)
    .where(
      and(
        isNull(wordartPresets.appId),
        or(
          and(eq(wordartPresets.userId, userId), eq(wordartPresets.scope, "user")),
          eq(wordartPresets.scope, "server")
        )
      )
    )
    .orderBy(desc(wordartPresets.createdAt));
  return rows.map(rowToPreset);
}

/** Get user + server presets for a specific app */
export async function getAppPresetsForUser(userId: string, appId: string): Promise<WordArtPreset[]> {
  await ensureSchema();
  const rows = await db
    .select()
    .from(wordartPresets)
    .where(
      and(
        eq(wordartPresets.appId, appId),
        or(
          and(eq(wordartPresets.userId, userId), eq(wordartPresets.scope, "user")),
          eq(wordartPresets.scope, "server")
        )
      )
    )
    .orderBy(desc(wordartPresets.createdAt));
  return rows.map(rowToPreset);
}

/** Get server presets for a specific app */
export async function getAppServerPresets(appId: string): Promise<WordArtPreset[]> {
  await ensureSchema();
  const rows = await db
    .select()
    .from(wordartPresets)
    .where(and(eq(wordartPresets.scope, "server"), eq(wordartPresets.appId, appId)))
    .orderBy(desc(wordartPresets.createdAt));
  return rows.map(rowToPreset);
}

export async function createPreset(
  userId: string,
  name: string,
  style: SiteNameStyle,
  scope: "user" | "server" = "user",
  appId?: string
): Promise<WordArtPreset> {
  await ensureSchema();
  const [row] = await db
    .insert(wordartPresets)
    .values({ userId, name, style: style as unknown as Record<string, unknown>, scope, appId: appId ?? null })
    .returning();
  return rowToPreset(row);
}

export async function deletePreset(
  id: string,
  userId: string,
  isAdmin = false
): Promise<boolean> {
  await ensureSchema();
  const [row] = await db
    .select()
    .from(wordartPresets)
    .where(eq(wordartPresets.id, id));

  if (!row) return false;
  if (row.scope === "user" && row.userId !== userId) return false;
  if (row.scope === "server" && !isAdmin) return false;

  const result = await db
    .delete(wordartPresets)
    .where(eq(wordartPresets.id, id))
    .returning();
  return result.length > 0;
}

export async function renamePreset(
  id: string,
  userId: string,
  newName: string,
  isAdmin = false
): Promise<WordArtPreset | null> {
  await ensureSchema();
  const [row] = await db
    .select()
    .from(wordartPresets)
    .where(eq(wordartPresets.id, id));

  if (!row) return null;
  if (row.scope === "user" && row.userId !== userId) return null;
  if (row.scope === "server" && !isAdmin) return null;

  const [updated] = await db
    .update(wordartPresets)
    .set({ name: newName })
    .where(eq(wordartPresets.id, id))
    .returning();
  return rowToPreset(updated);
}
