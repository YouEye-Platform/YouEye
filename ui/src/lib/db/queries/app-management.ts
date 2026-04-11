/**
 * App Management Queries
 *
 * Handles app registration, unregistration, manifest caching,
 * health monitoring, and info card provider discovery.
 */

import { db, ensureSchema } from "@/db";
import {
  apps,
  widgets,
  appPermissions,
  permissionAudit,
  webhookSubscriptions,
  interAppLog,
  userAppConfig,
} from "@/db/schema";
import { eq, or, and } from "drizzle-orm";

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  permissions?: string[];
  widgets?: AppWidgetDeclaration[];
  info_cards?: InfoCardDeclaration[];
  settings?: { schema: SettingField[] };
  inter_app?: {
    provides?: { type: string; description: string }[];
    consumes?: { app: string; types: string[] }[];
  };
}

export interface AppWidgetDeclaration {
  id: string;
  name: string;
  description: string;
  default_size: { width: number; height: number };
  min_size?: { width: number; height: number };
  max_size?: { width: number; height: number };
  refresh_interval?: number;
  settings_schema?: SettingField[];
}

export interface InfoCardDeclaration {
  type: string;
  description: string;
  endpoint: string;
  triggers: string[];
}

interface SettingField {
  key: string;
  type: string;
  label: string;
  required?: boolean;
  default?: unknown;
}

/** Register a new app in the database */
export async function registerApp(data: {
  id: string;
  name: string;
  version?: string;
  containerUrl: string;
  subdomain?: string;
  icon?: string;
  manifest?: Record<string, unknown>;
}): Promise<void> {
  await ensureSchema();

  const existing = await db
    .select()
    .from(apps)
    .where(eq(apps.id, data.id))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(apps)
      .set({
        name: data.name,
        version: data.version ?? existing[0].version,
        containerUrl: data.containerUrl,
        subdomain: data.subdomain,
        icon: data.icon,
        manifest: data.manifest ?? existing[0].manifest,
        updatedAt: new Date(),
      })
      .where(eq(apps.id, data.id));
  } else {
    await db.insert(apps).values({
      id: data.id,
      name: data.name,
      version: data.version,
      containerUrl: data.containerUrl,
      subdomain: data.subdomain,
      icon: data.icon,
      manifest: data.manifest ?? {},
    });
  }
}

/** Unregister an app and clean up all related data */
export async function unregisterApp(appId: string): Promise<void> {
  await ensureSchema();

  // Remove app-provided widgets from all users
  await db.delete(widgets).where(eq(widgets.appId, appId));

  // Remove all permissions for this app
  await db.delete(appPermissions).where(eq(appPermissions.appId, appId));

  // Remove audit log entries
  await db.delete(permissionAudit).where(eq(permissionAudit.appId, appId));

  // Remove webhook subscriptions
  await db
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.subscriberAppId, appId));

  // Remove inter-app logs
  await db
    .delete(interAppLog)
    .where(
      or(eq(interAppLog.fromAppId, appId), eq(interAppLog.toAppId, appId))
    );

  // Remove user app configs
  await db.delete(userAppConfig).where(eq(userAppConfig.appId, appId));

  // Remove the app itself
  await db.delete(apps).where(eq(apps.id, appId));
}

/** Update global app properties (admin only — affects all users' defaults) */
export async function updateGlobalApp(
  appId: string,
  data: {
    name?: string;
    icon?: string | null;
    subdomain?: string;
    displayOrder?: number;
  }
): Promise<typeof apps.$inferSelect | null> {
  await ensureSchema();

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.icon !== undefined) updateData.icon = data.icon;
  if (data.subdomain !== undefined) updateData.subdomain = data.subdomain;
  if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder;

  const [updated] = await db
    .update(apps)
    .set(updateData)
    .where(eq(apps.id, appId))
    .returning();

  return updated ?? null;
}

/** Update an app's cached manifest */
export async function updateAppManifest(
  appId: string,
  manifest: Record<string, unknown>
): Promise<void> {
  await ensureSchema();

  await db
    .update(apps)
    .set({ manifest, updatedAt: new Date() })
    .where(eq(apps.id, appId));
}

/** Update an app's health status */
export async function updateAppStatus(
  appId: string,
  status: "healthy" | "unhealthy" | "unknown"
): Promise<void> {
  await ensureSchema();

  await db
    .update(apps)
    .set({ status, updatedAt: new Date() })
    .where(eq(apps.id, appId));
}

/** Get a single app by ID */
export async function getApp(appId: string) {
  await ensureSchema();

  const [app] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);

  return app ?? null;
}

/** Get all apps that provide info cards */
export async function getInfoCardProviders(): Promise<
  Array<{
    appId: string;
    appName: string;
    containerUrl: string;
    cards: InfoCardDeclaration[];
  }>
> {
  await ensureSchema();

  const allApps = await db
    .select()
    .from(apps)
    .where(and(eq(apps.enabled, true)));

  const providers: Array<{
    appId: string;
    appName: string;
    containerUrl: string;
    cards: InfoCardDeclaration[];
  }> = [];

  for (const app of allApps) {
    const manifest = app.manifest as AppManifest | null;
    if (manifest?.info_cards && manifest.info_cards.length > 0 && app.containerUrl) {
      providers.push({
        appId: app.id,
        appName: app.name,
        containerUrl: app.containerUrl,
        cards: manifest.info_cards,
      });
    }
  }

  return providers;
}

/** Get all app widget declarations from installed apps */
export async function getAppWidgetDeclarations(): Promise<
  Array<{
    appId: string;
    appName: string;
    widgets: AppWidgetDeclaration[];
  }>
> {
  await ensureSchema();

  const allApps = await db
    .select()
    .from(apps)
    .where(eq(apps.enabled, true));

  const result: Array<{
    appId: string;
    appName: string;
    widgets: AppWidgetDeclaration[];
  }> = [];

  for (const app of allApps) {
    const manifest = app.manifest as AppManifest | null;
    if (manifest?.widgets && manifest.widgets.length > 0) {
      result.push({
        appId: app.id,
        appName: app.name,
        widgets: manifest.widgets,
      });
    }
  }

  return result;
}

/** Fetch manifest from an app's container */
export async function fetchAppManifest(
  containerUrl: string
): Promise<AppManifest | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${containerUrl}/api/manifest`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    return await response.json();
  } catch {
    return null;
  }
}

/** Check app health */
export async function checkAppHealth(
  containerUrl: string
): Promise<{ healthy: boolean; version?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${containerUrl}/api/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return { healthy: false };

    const data = await response.json();
    return {
      healthy: data.status === "healthy" || data.status === "ok",
      version: data.version,
    };
  } catch {
    return { healthy: false };
  }
}
