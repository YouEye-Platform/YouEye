/**
 * Branding Queries
 *
 * Read/write instance branding settings from system_settings table.
 * Keys: site_name, site_name_style, site_logo, site_favicon, site_accent_color
 */

import { db, ensureSchema } from "@/db";
import { systemSettings } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { isNextProductionBuild } from "@/lib/runtime-phase";
import { designSchema } from "@youeye/branding";

export interface SiteNameStyle {
  /** Canonical editable title and sticker; legacy readers use the CSS projection. */
  mytitle?: import("@youeye/branding").Design;
  mytitleRevision?: string;
  showHeaderLogo?: boolean;
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

function getDefaultBranding(): BrandingConfig {
  return {
    site_name: "YouEye",
    site_name_style: { ...DEFAULT_STYLE },
    logo_url: null,
    favicon_url: null,
    accent_color: "#8B5CF6",
    icon_config: null,
  };
}

export async function getBranding(): Promise<BrandingConfig> {
  if (isNextProductionBuild()) {
    return getDefaultBranding();
  }

  await ensureSchema();
  // A single statement observes one committed appearance, including during saves.
  const rows = await db.select().from(systemSettings).where(inArray(systemSettings.key, [
    "site_name", "site_name_style", "site_logo", "site_favicon", "site_accent_color", "site_icon_config",
  ]));
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const [name, style, logo, favicon, accent, iconCfg] = [
    values.site_name, values.site_name_style, values.site_logo, values.site_favicon, values.site_accent_color, values.site_icon_config,
  ];

  return {
    site_name: (name as string) ?? "YouEye",
    site_name_style: (style as SiteNameStyle) ?? { ...DEFAULT_STYLE },
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
    expected_revision: string | null;
  }>
) {
  let mytitleRevision: string | undefined;
  if (data.site_name_style?.showHeaderLogo !== undefined && typeof data.site_name_style.showHeaderLogo !== "boolean") throw new Error("Invalid header logo preference");
  if (data.expected_revision !== undefined && data.expected_revision !== null &&
      (typeof data.expected_revision !== "string" || !/^[a-f0-9]{64}$/.test(data.expected_revision))) {
    throw new Error("Invalid appearance revision");
  }
  if (data.site_name_style?.mytitle !== undefined) {
    if (data.expected_revision === undefined) throw new Error("An appearance revision is required");
    const design = designSchema.parse(data.site_name_style.mytitle);
    if (data.site_name !== undefined && data.site_name !== design.name) throw new Error("Title and server name must agree");
    const { prepareMyTitleAssets } = await import("@/lib/mytitle-assets");
    mytitleRevision = await prepareMyTitleAssets(design);
    data = { ...data, site_name: design.name, site_name_style: { ...data.site_name_style, mytitle: design, mytitleRevision } };
  }
  await ensureSchema();
  // One transaction keeps the editable design and compatibility fields together.
  await db.transaction(async (tx) => {
    // Serialize saves even on a fresh installation where no style row exists.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('youeye:branding', 0))`);
    if (data.expected_revision !== undefined) {
      const [current] = await tx.select().from(systemSettings).where(eq(systemSettings.key, "site_name_style"));
      const revision = (current?.value as SiteNameStyle | undefined)?.mytitleRevision ?? null;
      if (revision !== data.expected_revision && revision !== mytitleRevision) throw new BrandingConflictError();
    }
    for (const [key, value] of [
      ["site_name", data.site_name], ["site_name_style", data.site_name_style],
      ["site_accent_color", data.accent_color], ["site_icon_config", data.icon_config],
      ["site_logo", mytitleRevision ? `/branding/mytitle-${mytitleRevision}-48.png` : undefined],
      ["site_favicon", mytitleRevision ? `/branding/mytitle-${mytitleRevision}-32.png` : undefined],
    ] as const) {
      if (value === undefined) continue;
      await tx.insert(systemSettings).values({ key, value }).onConflictDoUpdate({
        target: systemSettings.key, set: { value, updatedAt: new Date() },
      });
    }
  });
  return getBranding();
}

export async function setBrandingAsset(
  type: "logo" | "favicon",
  url: string
) {
  const key = type === "logo" ? "site_logo" : "site_favicon";
  await ensureSchema();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('youeye:branding', 0))`);
    const [style] = await tx.select().from(systemSettings).where(eq(systemSettings.key, "site_name_style"));
    if ((style?.value as SiteNameStyle | undefined)?.mytitle) throw new Error("Edit the sticker in Title Studio");
    await tx.insert(systemSettings).values({ key, value: url }).onConflictDoUpdate({
      target: systemSettings.key, set: { value: url, updatedAt: new Date() },
    });
  });
}

export { DEFAULT_STYLE };

export class BrandingConflictError extends Error {
  constructor() { super("The server appearance changed. Reload before saving again."); }
}
