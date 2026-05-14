/**
 * Settings Database Queries
 *
 * Functions for reading and saving user preferences (theme, background, etc.)
 * and system-wide settings. Stored as JSONB in user_settings / system_settings tables.
 */

import { eq } from "drizzle-orm";
import { db, ensureSchema } from "@/db";
import { userSettings, systemSettings } from "@/db/schema";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import { locales, defaultLocale } from "@/i18n/config";

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

// ============================================
// System Language (One-Way Bridge)
// ============================================

/**
 * Get system-wide default language from local DB.
 * Returns the stored locale or "en" if not set.
 */
export async function getSystemLanguage(): Promise<string> {
  await ensureSchema();
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "site_language"));

  const lang = row?.value as string | null;
  if (lang && (locales as readonly string[]).includes(lang)) {
    return lang;
  }
  return defaultLocale;
}

/**
 * Set system-wide default language.
 * Called by the Control Panel via PUT /api/ui-bridge/language when admin changes system language.
 */
export async function setSystemLanguage(language: string): Promise<void> {
  await ensureSchema();

  // Validate locale
  if (!(locales as readonly string[]).includes(language)) {
    throw new Error(`Invalid locale: ${language}`);
  }

  const [existing] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "site_language"));

  if (existing) {
    await db
      .update(systemSettings)
      .set({ value: language, updatedAt: new Date() })
      .where(eq(systemSettings.key, "site_language"));
  } else {
    await db.insert(systemSettings).values({ key: "site_language", value: language });
  }
}

/**
 * Get a user's language preference (for i18n resolution).
 * Returns the user's override or null if not set.
 */
export async function getUserLanguage(userId: string): Promise<string | null> {
  const settings = await getUserSettings(userId);
  const lang = settings.language;
  if (typeof lang === "string" && (locales as readonly string[]).includes(lang)) {
    return lang;
  }
  return null;
}

// ============================================
// Drawer Preferences
// ============================================

export interface DrawerPrefs {
  columns: number;
  iconScale: number;
  maxHeight: number;
}

const DEFAULT_DRAWER_PREFS: DrawerPrefs = {
  columns: 3,
  iconScale: 1,
  maxHeight: 400,
};

export async function getDrawerPrefs(userId: string): Promise<DrawerPrefs> {
  const settings = await getUserSettings(userId);
  const prefs = settings.drawerPrefs as Partial<DrawerPrefs> | undefined;
  return {
    columns: prefs?.columns ?? DEFAULT_DRAWER_PREFS.columns,
    iconScale: prefs?.iconScale ?? DEFAULT_DRAWER_PREFS.iconScale,
    maxHeight: prefs?.maxHeight ?? DEFAULT_DRAWER_PREFS.maxHeight,
  };
}

export async function saveDrawerPrefs(
  userId: string,
  prefs: Partial<DrawerPrefs>
) {
  await ensureSchema();
  const existing = await getUserSettings(userId);
  const current = (existing.drawerPrefs as Partial<DrawerPrefs>) ?? {};
  const merged = { ...existing, drawerPrefs: { ...DEFAULT_DRAWER_PREFS, ...current, ...prefs } };

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
