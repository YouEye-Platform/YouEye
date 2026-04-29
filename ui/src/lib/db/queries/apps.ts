/**
 * Apps & App Drawer Queries
 *
 * Handles fetching apps from the local database,
 * merging with per-user customizations from user_app_config,
 * and managing drawer sections.
 */

import { db, ensureSchema } from "@/db";
import { apps, userAppConfig, userDrawerSections } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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
  customName: string | null;
  customIconUrl: string | null;
  visible: boolean;
  displayOrder: number;
  sectionId: string | null;
}

interface DrawerSection {
  sectionId: string;
  name: string;
  displayOrder: number;
  collapsed: boolean;
}

export async function getUserAppsWithConfig(userId: string): Promise<{
  apps: AppWithConfig[];
  sections: DrawerSection[];
}> {
  await ensureSchema();

  const [allApps, userConfigs, userSections] = await Promise.all([
    db.select().from(apps).where(eq(apps.enabled, true)),
    db.select().from(userAppConfig).where(eq(userAppConfig.userId, userId)),
    db
      .select()
      .from(userDrawerSections)
      .where(eq(userDrawerSections.userId, userId)),
  ]);

  const configMap = new Map(userConfigs.map((c) => [c.appId, c]));

  const mergedApps: AppWithConfig[] = allApps.map((app) => {
    const config = configMap.get(app.id);
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
      customName: config?.customName ?? null,
      customIconUrl: config?.customIconUrl ?? null,
      visible: config?.visible ?? true,
      displayOrder: config?.displayOrder ?? app.displayOrder ?? 0,
      sectionId: config?.sectionId ?? null,
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

  return { apps: mergedApps, sections };
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
    })
    .returning();
  return created;
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

export async function getAllApps() {
  await ensureSchema();
  return db.select().from(apps);
}
