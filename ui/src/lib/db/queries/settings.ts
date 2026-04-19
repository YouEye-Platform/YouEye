/**
 * Settings Database Queries
 *
 * Functions for reading and saving user preferences (theme, background, etc.)
 * and system-wide settings. Stored as JSONB in user_settings / system_settings tables.
 */

import { eq } from "drizzle-orm";
import { db, ensureSchema } from "@/db";
import { userSettings } from "@/db/schema";
import type { SiteNameStyle } from "@/lib/db/queries/branding";

/** Default background: animated flowing-lines with purple preset */
const DEFAULT_BACKGROUND = {
  type: "animated" as const,
  settings: {
    animatedStyle: "flowing-lines",
    animatedPreset: "purple",
  },
};

/**
 * Get a user's complete settings object.
 * Returns empty object if no settings exist yet.
 */
export async function getUserSettings(
  userId: string
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  return (rows[0]?.settings as Record<string, unknown>) ?? {};
}

/**
 * Get only the background portion of user settings.
 * Returns a typed { type, settings } object with sensible defaults.
 */
export async function getUserBackground(userId: string): Promise<{
  type: "solid" | "animated" | "image";
  settings: Record<string, unknown>;
}> {
  const settings = await getUserSettings(userId);
  const bg = settings.background as
    | { type?: string; settings?: Record<string, unknown> }
    | undefined;

  const validTypes = ["solid", "animated", "image"] as const;
  const rawType = bg?.type ?? DEFAULT_BACKGROUND.type;
  const type = validTypes.includes(rawType as typeof validTypes[number])
    ? (rawType as "solid" | "animated" | "image")
    : DEFAULT_BACKGROUND.type;

  return {
    type,
    settings: bg?.settings ?? DEFAULT_BACKGROUND.settings,
  };
}

/**
 * Save background settings for a user.
 * Merges into the existing settings JSONB — won't overwrite other prefs.
 */
export async function saveUserBackground(
  userId: string,
  type: string,
  bgSettings: Record<string, unknown>
) {
  await ensureSchema();

  const existing = await getUserSettings(userId);
  const merged = { ...existing, background: { type, settings: bgSettings } };

  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    await db.insert(userSettings).values({
      userId,
      settings: merged,
    });
  } else {
    await db
      .update(userSettings)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
  }

  return { type, settings: bgSettings };
}

export async function getUserWordartOverride(
  userId: string
): Promise<SiteNameStyle | null> {
  const settings = await getUserSettings(userId);
  return (settings.wordartOverride as SiteNameStyle) ?? null;
}

export async function saveUserWordartOverride(
  userId: string,
  style: SiteNameStyle
) {
  await ensureSchema();
  const existing = await getUserSettings(userId);
  const merged = { ...existing, wordartOverride: style };

  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    await db.insert(userSettings).values({ userId, settings: merged });
  } else {
    await db
      .update(userSettings)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
  }
}

export async function deleteUserWordartOverride(userId: string) {
  await ensureSchema();
  const existing = await getUserSettings(userId);
  const { wordartOverride: _, ...rest } = existing;

  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (rows.length > 0) {
    await db
      .update(userSettings)
      .set({ settings: rest, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));
  }
}
