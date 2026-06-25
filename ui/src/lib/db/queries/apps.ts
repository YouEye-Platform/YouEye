/**
 * Apps & App Drawer Queries
 *
 * Handles fetching apps from the local database,
 * merging with per-user customizations from user_app_config,
 * and managing drawer sections.
 */

import { db, ensureSchema } from "@/db";
import { apps, userAppConfig, userDrawerSections, userLauncherFolders } from "@/db/schema";
import { eq, and } from "drizzle-orm";

import type { SiteNameStyle } from "@/lib/db/queries/branding";

interface AppWithConfig {
  id: string;
  name: string;
  icon: string | null;
  containerUrl: string | null;
  subdomain: string | null;
  ssoEntryUrl: string | null;
  status: string | null;
  version: string | null;
  enabled: boolean | null;
  manifest: Record<string, unknown> | null;
  customName: string | null;
  customIconUrl: string | null;
  visible: boolean;
  displayOrder: number;
  sectionId: string | null;
  /** Launcher folder this app is in (null = loose in the launcher grid) */
  folderId: string | null;
  /** Resolved branding WordArt (user override > admin default > null) */
  brandingWordart: SiteNameStyle | null;
  /** Resolved header display mode (user override > admin default > 'logo-text') */
  headerDisplayMode: string;
  /** Admin-set branding (for settings UI to show server default) */
  adminBrandingWordart: SiteNameStyle | null;
  adminHeaderDisplayMode: string;
}

interface DrawerSection {
  sectionId: string;
  name: string;
  displayOrder: number;
  collapsed: boolean;
}

interface LauncherFolder {
  folderId: string;
  name: string;
  displayOrder: number;
}

export async function getUserAppsWithConfig(userId: string): Promise<{
  apps: AppWithConfig[];
  sections: DrawerSection[];
  folders: LauncherFolder[];
}> {
  await ensureSchema();

  const [allApps, userConfigs, userSections, userFolders] = await Promise.all([
    db.select().from(apps).where(eq(apps.enabled, true)),
    db.select().from(userAppConfig).where(eq(userAppConfig.userId, userId)),
    db
      .select()
      .from(userDrawerSections)
      .where(eq(userDrawerSections.userId, userId)),
    db
      .select()
      .from(userLauncherFolders)
      .where(eq(userLauncherFolders.userId, userId)),
  ]);

  const configMap = new Map(userConfigs.map((c) => [c.appId, c]));

  const mergedApps: AppWithConfig[] = allApps.map((app) => {
    const config = configMap.get(app.id);
    const adminWordart = (app.brandingWordart as unknown as SiteNameStyle) ?? null;
    const adminMode = app.headerDisplayMode ?? "logo-text";
    return {
      id: app.id,
      name: app.name,
      icon: app.icon,
      containerUrl: app.containerUrl,
      subdomain: app.subdomain,
      ssoEntryUrl: app.ssoEntryUrl ?? null,
      status: app.status,
      version: app.version ?? null,
      enabled: app.enabled,
      manifest: app.manifest ?? null,
      customName: config?.customName ?? null,
      customIconUrl: config?.customIconUrl ?? null,
      visible: config?.visible ?? true,
      displayOrder: config?.displayOrder ?? app.displayOrder ?? 0,
      sectionId: config?.sectionId ?? null,
      folderId: config?.folderId ?? null,
      brandingWordart: (config?.brandingWordart as unknown as SiteNameStyle) ?? adminWordart,
      headerDisplayMode: config?.headerDisplayMode ?? adminMode,
      adminBrandingWordart: adminWordart,
      adminHeaderDisplayMode: adminMode,
    };
  });

  mergedApps.sort((a, b) => a.displayOrder - b.displayOrder);

  const sections: DrawerSection[] = userSections.map((s) => ({
    sectionId: s.sectionId,
    name: s.name,
    displayOrder: s.displayOrder ?? 0,
    collapsed: s.collapsed ?? false,
  }));

  sections.sort((a, b) => a.displayOrder - b.displayOrder);

  const folders: LauncherFolder[] = userFolders
    .map((f) => ({
      folderId: f.folderId,
      name: f.name,
      displayOrder: f.displayOrder ?? 0,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return { apps: mergedApps, sections, folders };
}

export async function updateAppConfig(
  userId: string,
  appId: string,
  data: {
    customName?: string | null;
    customIconUrl?: string | null;
    visible?: boolean;
    displayOrder?: number;
    sectionId?: string | null;
    folderId?: string | null;
  }
) {
  await ensureSchema();

  const [existing] = await db
    .select()
    .from(userAppConfig)
    .where(
      and(eq(userAppConfig.userId, userId), eq(userAppConfig.appId, appId))
    );

  if (existing) {
    const [updated] = await db
      .update(userAppConfig)
      .set({
        customName: data.customName !== undefined ? data.customName : existing.customName,
        customIconUrl: data.customIconUrl !== undefined ? data.customIconUrl : existing.customIconUrl,
        visible: data.visible !== undefined ? data.visible : existing.visible,
        displayOrder: data.displayOrder !== undefined ? data.displayOrder : existing.displayOrder,
        sectionId: data.sectionId !== undefined ? data.sectionId : existing.sectionId,
        folderId: data.folderId !== undefined ? data.folderId : existing.folderId,
      })
      .where(eq(userAppConfig.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(userAppConfig)
    .values({
      userId,
      appId,
      customName: data.customName ?? null,
      customIconUrl: data.customIconUrl ?? null,
      visible: data.visible ?? true,
      displayOrder: data.displayOrder ?? 0,
      sectionId: data.sectionId ?? null,
      folderId: data.folderId ?? null,
    })
    .returning();
  return created;
}

/**
 * Replace the user's launcher folders (Plan 5). Mirrors updateDrawerSections —
 * the client sends the full desired folder set (create/rename/delete in one
 * call). App→folder membership lives on user_app_config.folder_id, set via
 * updateAppConfig.
 */
export async function updateLauncherFolders(
  userId: string,
  folders: { id: string; name: string; order: number }[]
) {
  await ensureSchema();

  await db
    .delete(userLauncherFolders)
    .where(eq(userLauncherFolders.userId, userId));

  if (folders.length === 0) return [];

  const rows = folders.map((f) => ({
    userId,
    folderId: f.id,
    name: f.name,
    displayOrder: f.order,
  }));

  return db.insert(userLauncherFolders).values(rows).returning();
}

export async function updateDrawerSections(
  userId: string,
  sections: { id: string; name: string; order: number; collapsed?: boolean }[]
) {
  await ensureSchema();

  // Delete existing sections for this user
  await db
    .delete(userDrawerSections)
    .where(eq(userDrawerSections.userId, userId));

  if (sections.length === 0) return [];

  const rows = sections.map((s) => ({
    userId,
    sectionId: s.id,
    name: s.name,
    displayOrder: s.order,
    collapsed: s.collapsed ?? false,
  }));

  return db.insert(userDrawerSections).values(rows).returning();
}

/** Admin: update the server-default branding for an app */
export async function updateAppBranding(
  appId: string,
  data: {
    brandingWordart?: SiteNameStyle | null;
    headerDisplayMode?: string;
  }
) {
  await ensureSchema();
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.brandingWordart !== undefined) {
    updates.brandingWordart = data.brandingWordart
      ? (data.brandingWordart as unknown as Record<string, unknown>)
      : null;
  }
  if (data.headerDisplayMode !== undefined) {
    updates.headerDisplayMode = data.headerDisplayMode;
  }
  const [row] = await db
    .update(apps)
    .set(updates)
    .where(eq(apps.id, appId))
    .returning();
  return row;
}

/** User: update per-user branding override for an app */
export async function updateUserAppBranding(
  userId: string,
  appId: string,
  data: {
    brandingWordart?: SiteNameStyle | null;
    headerDisplayMode?: string | null;
    customName?: string | null;
    customIconUrl?: string | null;
  }
) {
  await ensureSchema();

  const [existing] = await db
    .select()
    .from(userAppConfig)
    .where(
      and(eq(userAppConfig.userId, userId), eq(userAppConfig.appId, appId))
    );

  const updates: Record<string, unknown> = {};
  if (data.brandingWordart !== undefined) {
    updates.brandingWordart = data.brandingWordart
      ? (data.brandingWordart as unknown as Record<string, unknown>)
      : null;
  }
  if (data.headerDisplayMode !== undefined) {
    updates.headerDisplayMode = data.headerDisplayMode;
  }
  if (data.customName !== undefined) {
    updates.customName = data.customName;
  }
  if (data.customIconUrl !== undefined) {
    updates.customIconUrl = data.customIconUrl;
  }

  if (existing) {
    const [row] = await db
      .update(userAppConfig)
      .set(updates)
      .where(eq(userAppConfig.id, existing.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(userAppConfig)
    .values({
      userId,
      appId,
      ...updates,
    })
    .returning();
  return row;
}

export async function getAllApps() {
  await ensureSchema();
  return db.select().from(apps);
}
