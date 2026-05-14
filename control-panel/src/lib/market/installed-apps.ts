/**
 * Installed Apps — JSON-backed tracking of installed app versions.
 *
 * Stores app inventory, version tracking, and update detection in a local
 * JSON file at /var/lib/youeye/state/installed-apps.json. This decouples
 * CP's own operational data from PostgreSQL, allowing CP to function fully
 * when PostgreSQL is down (e.g., for troubleshooting).
 *
 * All external consumers import functions by name — the storage swap is
 * invisible to callers.
 */

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';
import { listInstalledApps, readInstallMetadata } from './metadata';
import { fetchCatalog, fetchRepoFile, getEffectiveBranch } from './catalog';
import { parse as parseYAML } from 'yaml';
import { isNewer } from '@/lib/version';

const STORE_PATH = statePath('installed-apps.json');

// ─── Types ────────────────────────────────────────────────────

export interface InstalledApp {
  id: number;
  appId: string;
  type: 'native' | 'basic' | 'marketplace';
  installedVersion: string;
  catalogVersion: string | null;
  updateAvailable: boolean;
  installedAt: string;
  subdomain: string;
  ssoSlug: string | null;
  forwardAuthEnabled: boolean;
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  healthCheckedAt: string | null;
  source: 'catalog' | 'url';
  sourceUrl: string | null;
}

interface InstalledAppsStore {
  apps: Record<string, InstalledApp>;
  nextId: number;
}

// ─── Store Management ─────────────────────────────────────────

let store: InstalledAppsStore | null = null;

async function loadStore(): Promise<InstalledAppsStore> {
  if (store) return store;
  store = await readJSON<InstalledAppsStore>(STORE_PATH) ?? { apps: {}, nextId: 1 };
  return store;
}

async function saveStore(): Promise<void> {
  if (!store) return;
  await writeJSON(STORE_PATH, store);
}

// ─── CRUD Operations ──────────────────────────────────────────

export async function getAllInstalledApps(): Promise<InstalledApp[]> {
  const s = await loadStore();
  return Object.values(s.apps).sort(
    (a, b) => new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime()
  );
}

export async function getInstalledApp(appId: string): Promise<InstalledApp | null> {
  const s = await loadStore();
  return s.apps[appId] ?? null;
}

export async function upsertInstalledApp(data: {
  appId: string;
  type: string;
  installedVersion: string;
  subdomain: string;
  ssoSlug?: string | null;
  forwardAuthEnabled?: boolean;
}): Promise<void> {
  const s = await loadStore();
  const existing = s.apps[data.appId];

  if (existing) {
    existing.type = data.type as InstalledApp['type'];
    existing.installedVersion = data.installedVersion;
    existing.subdomain = data.subdomain;
    existing.ssoSlug = data.ssoSlug ?? existing.ssoSlug;
    existing.forwardAuthEnabled = data.forwardAuthEnabled ?? existing.forwardAuthEnabled;
  } else {
    s.apps[data.appId] = {
      id: s.nextId++,
      appId: data.appId,
      type: data.type as InstalledApp['type'],
      installedVersion: data.installedVersion,
      catalogVersion: null,
      updateAvailable: false,
      installedAt: new Date().toISOString(),
      subdomain: data.subdomain,
      ssoSlug: data.ssoSlug ?? null,
      forwardAuthEnabled: data.forwardAuthEnabled ?? false,
      healthStatus: 'unknown',
      healthCheckedAt: null,
      source: 'catalog',
      sourceUrl: null,
    };
  }

  await saveStore();
}

export async function removeInstalledApp(appId: string): Promise<void> {
  const s = await loadStore();
  delete s.apps[appId];
  await saveStore();
}

export async function updateInstalledAppSubdomain(appId: string, subdomain: string): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].subdomain = subdomain;
    await saveStore();
  }
}

export async function updateInstalledVersion(appId: string, version: string): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].installedVersion = version;
    s.apps[appId].updateAvailable = false;
    await saveStore();
  }
}

export async function updateInstalledAppSource(
  appId: string,
  source: 'catalog' | 'url',
  sourceUrl?: string
): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].source = source;
    s.apps[appId].sourceUrl = sourceUrl ?? null;
    await saveStore();
  }
}

// ─── Migration from install.json ──────────────────────────────

export async function migrateFromInstallJson(): Promise<number> {
  const s = await loadStore();
  const existingIds = new Set(Object.keys(s.apps));

  const jsonApps = await listInstalledApps();
  let migrated = 0;

  for (const meta of jsonApps) {
    if (existingIds.has(meta.appId)) continue;

    await upsertInstalledApp({
      appId: meta.appId,
      type: meta.integration || 'basic',
      installedVersion: meta.installedVersion ?? '',
      subdomain: meta.subdomain,
      ssoSlug: meta.ssoSlug,
    });
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[installed-apps] Migrated ${migrated} apps from install.json to JSON store`);
  }
  return migrated;
}

// ─── Update Detection ─────────────────────────────────────────

async function fetchNativeAppVersion(
  repo: string,
  manifestFile: string,
  branch: string,
): Promise<string | null> {
  try {
    const [owner, repoName] = repo.split('/');
    const manifestYaml = await fetchRepoFile(owner, repoName, manifestFile, branch);
    const parsed = parseYAML(manifestYaml);
    return parsed?.version ?? null;
  } catch (err) {
    console.warn('[installed-apps] Failed to fetch app version from repo:', err);
    return null;
  }
}

async function fetchUrlAppVersion(sourceUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'text/yaml, application/yaml, text/plain, */*', 'User-Agent': 'YouEye-AppMarket/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const yamlText = await res.text();
    if (yamlText.length > 1024 * 1024) return null;

    const parsed = parseYAML(yamlText, { maxAliasCount: 0 });
    return parsed?.version ?? null;
  } catch (err) {
    console.warn('[installed-apps] Failed to fetch URL app version:', sourceUrl, err);
    return null;
  }
}

/**
 * Compare each installed app's version against the latest available version.
 * Updates catalogVersion and updateAvailable in the JSON store.
 * Single load + single save instead of N psql roundtrips.
 */
export async function checkForUpdates(): Promise<InstalledApp[]> {
  let catalog;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    console.error('[installed-apps] Failed to fetch catalog for update check:', err);
    return [];
  }

  const branch = await getEffectiveBranch();
  const s = await loadStore();
  const installed = Object.values(s.apps);
  const appsWithUpdates: InstalledApp[] = [];

  const entryMap = new Map<string, { file?: string; repo?: string; manifest?: string; latestVersion?: string; integration?: string }>();
  for (const e of catalog.apps) {
    entryMap.set(e.id, e);
  }

  for (const app of installed) {
    let catalogVersion: string | null = null;

    const entry = entryMap.get(app.appId);

    if (entry?.repo) {
      catalogVersion = await fetchNativeAppVersion(entry.repo, entry.manifest || 'youeye-app.yaml', branch);
    } else if (entry?.latestVersion) {
      catalogVersion = entry.latestVersion;
    } else if (!entry && app.source === 'url' && app.sourceUrl) {
      catalogVersion = await fetchUrlAppVersion(app.sourceUrl);
    }

    let hasUpdate = false;
    if (catalogVersion && app.installedVersion) {
      try {
        hasUpdate = isNewer(catalogVersion, app.installedVersion);
      } catch {
        hasUpdate = false;
      }
    }

    app.catalogVersion = catalogVersion;
    app.updateAvailable = hasUpdate;

    if (hasUpdate) {
      appsWithUpdates.push({ ...app });
    }
  }

  await saveStore();
  return appsWithUpdates;
}

export async function getAppsWithUpdatesAvailable(): Promise<InstalledApp[]> {
  const s = await loadStore();
  return Object.values(s.apps).filter(a => a.updateAvailable).sort((a, b) => a.appId.localeCompare(b.appId));
}

// ─── Forward-Auth Toggle ─────────────────────────────────────

export async function updateForwardAuthEnabled(appId: string, enabled: boolean): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].forwardAuthEnabled = enabled;
    await saveStore();
  }
}

// ─── Health Status ───────────────────────────────────────────

export async function updateHealthStatus(
  appId: string,
  status: 'healthy' | 'unhealthy' | 'unknown',
): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].healthStatus = status;
    s.apps[appId].healthCheckedAt = new Date().toISOString();
    await saveStore();
  }
}
