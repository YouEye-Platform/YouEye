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
import { eq, or } from "drizzle-orm";

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  /** Accent color for timeline cards, badges, etc. (hex, e.g. "#a855f7") */
  accent_color?: string;
  permissions?: string[];
  widgets?: AppWidgetDeclaration[];
  info_cards?: InfoCardDeclaration[];
  timeline_embeds?: TimelineEmbedDeclaration[];
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
  embed_path?: string;
  label?: string;
}

export interface TimelineEmbedDeclaration {
  entry_type: string;
  embed_path: string;
  description?: string;
  /** Lucide icon name for this entry type (e.g. "Eye", "Play") */
  icon?: string;
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
  tokenHash?: string;
  ssoEntryUrl?: string;
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
        tokenHash: data.tokenHash ?? existing[0].tokenHash,
        ssoEntryUrl: data.ssoEntryUrl ?? existing[0].ssoEntryUrl,
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
      tokenHash: data.tokenHash,
      ssoEntryUrl: data.ssoEntryUrl,
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

/** App metadata for timeline rendering (icon, color, per-entry-type icons) */
export interface AppMeta {
  icon: string | null;
  accent_color: string | null;
  /** Map of entry_type → lucide icon name from timeline_embeds in manifest */
  entry_icons: Record<string, string>;
}

/** Get app metadata map for all enabled apps (used by timeline feed) */
export async function getAppMetaMap(): Promise<Record<string, AppMeta>> {
  await ensureSchema();

  const allApps = await db
    .select({
      id: apps.id,
      icon: apps.icon,
      manifest: apps.manifest,
    })
    .from(apps)
    .where(eq(apps.enabled, true));

  const result: Record<string, AppMeta> = {};
  for (const app of allApps) {
    const manifest = app.manifest as Record<string, unknown> | null;
    const accentColor = (manifest?.accent_color as string) ?? null;
    const timelineEmbeds = (manifest?.timeline_embeds as Array<{ entry_type: string; icon?: string }>) ?? [];

    const entryIcons: Record<string, string> = {};
    for (const embed of timelineEmbeds) {
      if (embed.icon) {
        entryIcons[embed.entry_type] = embed.icon;
      }
    }

    result[app.id] = {
      icon: app.icon ?? null,
      accent_color: accentColor,
      entry_icons: entryIcons,
    };
  }
  return result;
}

/** Get all apps that provide info cards by live-fetching runtime manifests */
export async function getInfoCardProviders(): Promise<
  Array<{
    appId: string;
    appName: string;
    containerUrl: string;
    subdomain: string | null;
    icon: string | null;
    cards: InfoCardDeclaration[];
  }>
> {
  await ensureSchema();

  const allApps = await db
    .select()
    .from(apps)
    .where(eq(apps.enabled, true));

  // Discover real container IPs via Caddy (avoids cross-bridge DNS issues)
  const upstreamMap = await discoverAppUpstreams();

  const results = await Promise.allSettled(
    allApps
      .filter((app) => app.containerUrl || app.subdomain)
      .map(async (app) => {
        const upstream =
          (app.subdomain && upstreamMap.get(app.subdomain)) ||
          app.containerUrl;
        if (!upstream) return null;

        const manifest = await fetchAppManifest(upstream);

        // Fall back to DB manifest if live fetch fails
        const effective = manifest ?? (app.manifest as AppManifest | null);
        if (
          effective?.info_cards &&
          effective.info_cards.length > 0
        ) {
          return {
            appId: app.id,
            appName: app.name,
            containerUrl: app.containerUrl ?? upstream,
            subdomain: app.subdomain ?? null,
            icon: app.icon ?? effective.icon ?? null,
            cards: effective.info_cards,
          };
        }
        return null;
      })
  );

  const out: Array<{
    appId: string;
    appName: string;
    containerUrl: string;
    subdomain: string | null;
    icon: string | null;
    cards: InfoCardDeclaration[];
  }> = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
  }
  return out;
}

/** Get all app widget declarations by live-fetching from running app containers */
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

  // Discover app backend URLs from Caddy's live config
  const upstreamMap = await discoverAppUpstreams();

  const results = await Promise.allSettled(
    allApps
      .filter((app) => app.containerUrl || app.subdomain)
      .map(async (app) => {
        // Prefer Caddy-discovered upstream (avoids cross-bridge DNS issues),
        // fall back to DB containerUrl
        const upstream = (app.subdomain && upstreamMap.get(app.subdomain))
          || app.containerUrl;
        if (!upstream) return null;

        const manifest = await fetchAppManifest(upstream);
        if (manifest?.widgets && manifest.widgets.length > 0) {
          return {
            appId: app.id,
            appName: app.name,
            widgets: manifest.widgets,
          };
        }
        return null;
      })
  );

  const out: Array<{ appId: string; appName: string; widgets: AppWidgetDeclaration[] }> = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
  }
  return out;
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

/**
 * Discover app backend URLs from Caddy's admin API.
 * Caddy is on the same Incus bridge as UI (youeye-caddy.youeye resolves),
 * and its config contains the actual app container IPs as upstreams.
 * Returns a map of subdomain → "http://<ip>:<port>".
 *
 * Uses Node http module instead of fetch — fetch adds an Origin header
 * that Caddy's admin API rejects.
 */
async function discoverAppUpstreams(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const http = await import("http");
    const data = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        "http://youeye-caddy.youeye:2019/config/apps/http/servers",
        (res) => {
          let body = "";
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve(body));
        }
      );
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });

    const servers = JSON.parse(data) as Record<
      string,
      {
        routes?: Array<{
          match?: Array<{ host?: string[] }>;
          handle?: Array<{
            handler?: string;
            upstreams?: Array<{ dial?: string }>;
          }>;
        }>;
      }
    >;

    for (const server of Object.values(servers)) {
      for (const route of server.routes ?? []) {
        const hosts = route.match?.[0]?.host ?? [];
        const proxy = route.handle?.find((h) => h.handler === "reverse_proxy");
        const dial = proxy?.upstreams?.[0]?.dial;
        if (!dial) continue;

        for (const host of hosts) {
          const dot = host.indexOf(".");
          if (dot > 0) {
            map.set(host.substring(0, dot), `http://${dial}`);
          }
        }
      }
    }
  } catch {
    // Caddy unreachable — fall back to DB containerUrl
  }
  return map;
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
