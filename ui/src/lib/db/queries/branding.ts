/**
 * Branding Queries
 *
 * Read/write instance branding settings from system_settings table.
 * Keys: site_name, site_name_style, site_logo, site_favicon, site_accent_color
 */

import { db, ensureSchema } from "@/db";
import { systemSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface SiteNameStyle {
  fontFamily: string;
  fontSize: string;
  fontWeight: number;
  letterSpacing: string;
  color: string;
  gradient: {
    enabled: boolean;
    from: string;
    to: string;
    direction: string;
  } | null;
  textShadow: string;
  textTransform: string;
  textStroke?: string;
  transform?: string;
  /** ID of a per-character shape preset (e.g. 'char-wave') */
  charShapeId?: string;
  /** Intensity for per-character shape (0-2, default 1) */
  charShapeIntensity?: number;
}

export interface BrandingConfig {
  site_name: string;
  site_name_style: SiteNameStyle | null;
  logo_url: string | null;
  favicon_url: string | null;
  accent_color: string;
  icon_config: import("@/lib/icon-config").IconConfig | null;
}

const DEFAULT_STYLE: SiteNameStyle = {
  fontFamily: "Inter",
  fontSize: "1.5rem",
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#ffffff",
  gradient: null,
  textShadow: "none",
  textTransform: "none",
};

async function getSystemSetting(key: string): Promise<unknown | null> {
  await ensureSchema();
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  return row?.value ?? null;
}

async function setSystemSetting(key: string, value: unknown) {
  await ensureSchema();
  const [existing] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key));

  if (existing) {
    await db
      .update(systemSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(systemSettings.key, key));
  } else {
    await db.insert(systemSettings).values({ key, value });
  }
}

export async function getBranding(): Promise<BrandingConfig> {
  await ensureSchema();
  const [name, style, logo, favicon, accent, iconCfg] = await Promise.all([
    getSystemSetting("site_name"),
    getSystemSetting("site_name_style"),
    getSystemSetting("site_logo"),
    getSystemSetting("site_favicon"),
    getSystemSetting("site_accent_color"),
    getSystemSetting("site_icon_config"),
  ]);

  return {
    site_name: (name as string) ?? "YouEye",
    site_name_style: (style as SiteNameStyle) ?? DEFAULT_STYLE,
    logo_url: (logo as string) ?? null,
    favicon_url: (favicon as string) ?? null,
    accent_color: (accent as string) ?? "#8B5CF6",
    icon_config: (iconCfg as import("@/lib/icon-config").IconConfig) ?? null,
  };
}

export async function updateBranding(
  data: Partial<{
    site_name: string;
    site_name_style: SiteNameStyle;
    accent_color: string;
    icon_config: import("@/lib/icon-config").IconConfig;
  }>
) {
  const updates: Promise<void>[] = [];

  if (data.site_name !== undefined) {
    updates.push(setSystemSetting("site_name", data.site_name));
  }
  if (data.site_name_style !== undefined) {
    updates.push(setSystemSetting("site_name_style", data.site_name_style));
  }
  if (data.accent_color !== undefined) {
    updates.push(setSystemSetting("site_accent_color", data.accent_color));
  }
  if (data.icon_config !== undefined) {
    updates.push(setSystemSetting("site_icon_config", data.icon_config));
  }

  await Promise.all(updates);
  return getBranding();
}

export async function setBrandingAsset(
  type: "logo" | "favicon",
  url: string
) {
  const key = type === "logo" ? "site_logo" : "site_favicon";
  await setSystemSetting(key, url);
}

export { DEFAULT_STYLE };
