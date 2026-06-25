/**
 * Theme Queries
 *
 * CRUD operations for themes and user theme preferences.
 * Follows the same pattern as other query files (ensureSchema, Drizzle ORM).
 */

import { db, ensureSchema } from "@/db";
import { themes, userThemePreferences } from "@/db/schema";
import type { ThemeColors } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// ─── Types ──────────────────────────────────────────────────────────

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
  isPreset: boolean;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface UserThemePreference {
  id: string;
  userId: string;
  themeId: string;
  appOverrides: Record<string, string>;
  updatedAt: Date | null;
}

// ─── Theme CRUD ──────────────────────────────────────────────────────

/**
 * List all themes (presets + user-created)
 */
export async function listThemes(): Promise<Theme[]> {
  await ensureSchema();
  const rows = await db.select().from(themes).orderBy(themes.isPreset, themes.name);
  return rows.map(mapThemeRow);
}

/**
 * List only preset themes
 */
export async function listPresetThemes(): Promise<Theme[]> {
  await ensureSchema();
  const rows = await db.select().from(themes).where(eq(themes.isPreset, true));
  return rows.map(mapThemeRow);
}

/**
 * Get a single theme by ID
 */
export async function getThemeById(id: string): Promise<Theme | null> {
  await ensureSchema();
  const [row] = await db.select().from(themes).where(eq(themes.id, id));
  return row ? mapThemeRow(row) : null;
}

/**
 * Get the default (first preset) theme — used as fallback
 */
export async function getDefaultTheme(): Promise<Theme | null> {
  await ensureSchema();
  const [row] = await db
    .select()
    .from(themes)
    .where(eq(themes.isPreset, true))
    .limit(1);
  return row ? mapThemeRow(row) : null;
}

/**
 * Create a new custom theme
 */
export async function createTheme(data: {
  name: string;
  colors: ThemeColors;
  createdBy?: string;
}): Promise<Theme> {
  await ensureSchema();
  const [row] = await db
    .insert(themes)
    .values({
      name: data.name,
      colors: data.colors,
      isPreset: false,
      createdBy: data.createdBy ?? null,
    })
    .returning();
  return mapThemeRow(row);
}

/**
 * Update a custom theme (cannot update presets)
 */
export async function updateTheme(
  id: string,
  data: Partial<{ name: string; colors: ThemeColors }>
): Promise<Theme | null> {
  await ensureSchema();

  // Verify it's not a preset
  const existing = await getThemeById(id);
  if (!existing || existing.isPreset) return null;

  const [row] = await db
    .update(themes)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(themes.id, id), eq(themes.isPreset, false)))
    .returning();
  return row ? mapThemeRow(row) : null;
}

/**
 * Delete a custom theme (cannot delete presets)
 */
export async function deleteTheme(id: string): Promise<boolean> {
  await ensureSchema();

  // Verify it's not a preset
  const existing = await getThemeById(id);
  if (!existing || existing.isPreset) return false;

  const result = await db
    .delete(themes)
    .where(and(eq(themes.id, id), eq(themes.isPreset, false)))
    .returning();
  return result.length > 0;
}

// ─── User Theme Preferences ──────────────────────────────────────────

/**
 * Get a user's active theme preference with the full theme data.
 * Returns null if no preference is set.
 */
export async function getUserActiveTheme(
  userId: string
): Promise<{ preference: UserThemePreference; theme: Theme } | null> {
  await ensureSchema();

  const [pref] = await db
    .select()
    .from(userThemePreferences)
    .where(eq(userThemePreferences.userId, userId));

  if (!pref) return null;

  const theme = await getThemeById(pref.themeId);
  if (!theme) return null;

  return {
    preference: {
      id: pref.id,
      userId: pref.userId,
      themeId: pref.themeId,
      appOverrides: (pref.appOverrides as Record<string, string>) ?? {},
      updatedAt: pref.updatedAt,
    },
    theme,
  };
}

/**
 * Set a user's active theme. Creates or updates the preference.
 */
export async function setUserActiveTheme(
  userId: string,
  themeId: string
): Promise<UserThemePreference | null> {
  await ensureSchema();

  // Verify the theme exists
  const theme = await getThemeById(themeId);
  if (!theme) return null;

  // Upsert the preference
  const [existing] = await db
    .select()
    .from(userThemePreferences)
    .where(eq(userThemePreferences.userId, userId));

  if (existing) {
    const [row] = await db
      .update(userThemePreferences)
      .set({ themeId, updatedAt: new Date() })
      .where(eq(userThemePreferences.userId, userId))
      .returning();
    return row
      ? {
          id: row.id,
          userId: row.userId,
          themeId: row.themeId,
          appOverrides: (row.appOverrides as Record<string, string>) ?? {},
          updatedAt: row.updatedAt,
        }
      : null;
  }

  const [row] = await db
    .insert(userThemePreferences)
    .values({ userId, themeId })
    .returning();
  return row
    ? {
        id: row.id,
        userId: row.userId,
        themeId: row.themeId,
        appOverrides: (row.appOverrides as Record<string, string>) ?? {},
        updatedAt: row.updatedAt,
      }
    : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function mapThemeRow(row: typeof themes.$inferSelect): Theme {
  return {
    id: row.id,
    name: row.name,
    colors: row.colors as ThemeColors,
    isPreset: row.isPreset ?? false,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
