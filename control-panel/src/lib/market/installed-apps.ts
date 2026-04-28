/**
 * Installed Apps — PostgreSQL-backed tracking of installed app versions.
 *
 * Creates and manages the `installed_apps` table in the shared PostgreSQL
 * instance. Used for version tracking, update detection, and app inventory.
 *
 * The table lives in the same PostgreSQL as other CP data. On first use,
 * the table is created if it doesn't exist. Existing install.json files
 * are migrated into the table automatically.
 */

import { execShell } from '@/lib/incus/server';
import { listInstalledApps, readInstallMetadata } from './metadata';
import { fetchCatalog, fetchRepoFile, getEffectiveBranch } from './catalog';
import { parse as parseYAML } from 'yaml';
import { isNewer } from '@/lib/version';

const POSTGRES_CONTAINER = 'youeye-postgres';

// ─── Types ────────────────────────────────────────────────────

export interface InstalledApp {
  id: number;
  appId: string;
  type: 'native' | 'basic' | 'marketplace'; // v2: native|basic; legacy: marketplace
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

// ─── Table Management ─────────────────────────────────────────

let tableCreated = false;

async function psql(sql: string): Promise<string> {
  const escaped = sql.replace(/'/g, "'\\''");
  // BUG-025: Use 'psql -U youeye' directly instead of 'su - postgres -c "psql ..."'.
  // BusyBox's su (used in Alpine-based containers) has limited flag support and
  // mangles the nested quoting, causing the command to fail and preventing the
  // installed_apps table from being created. Using -U youeye works because the
  // youeye superuser is always created during PostgreSQL setup.
  const result = await execShell(
    POSTGRES_CONTAINER,
    `psql -U youeye -t -A -c '${escaped}'`,
    { timeout: 10_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function ensureTable(): Promise<void> {
  if (tableCreated) return;

  await psql(`
    CREATE TABLE IF NOT EXISTS installed_apps (
      id SERIAL PRIMARY KEY,
      app_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'marketplace',
      installed_version TEXT NOT NULL DEFAULT '',
      catalog_version TEXT,
      update_available BOOLEAN NOT NULL DEFAULT FALSE,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      subdomain TEXT NOT NULL DEFAULT '',
      sso_slug TEXT,
      forward_auth_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      health_status TEXT NOT NULL DEFAULT 'unknown',
      health_checked_at TIMESTAMPTZ
    )
  `);

  // Schema migration: add new columns to existing tables
  try {
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS forward_auth_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown'`);
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ`);
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'catalog'`);
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS source_url TEXT`);
  } catch {
    // Columns may already exist
  }

  tableCreated = true;
}

// ─── CRUD Operations ──────────────────────────────────────────

function parseRows(raw: string): InstalledApp[] {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const [id, appId, type, installedVersion, catalogVersion, updateAvailable, installedAt, subdomain, ssoSlug, forwardAuthEnabled, healthStatus, healthCheckedAt, source, sourceUrl] = line.split('|');
    return {
      id: parseInt(id, 10),
      appId,
      type: type as 'native' | 'basic' | 'marketplace',
      installedVersion,
      catalogVersion: catalogVersion || null,
      updateAvailable: updateAvailable === 't',
      installedAt,
      subdomain,
      ssoSlug: ssoSlug || null,
      forwardAuthEnabled: forwardAuthEnabled === 't',
      healthStatus: (healthStatus as 'healthy' | 'unhealthy' | 'unknown') || 'unknown',
      healthCheckedAt: healthCheckedAt || null,
      source: (source as 'catalog' | 'url') || 'catalog',
      sourceUrl: sourceUrl || null,
    };
  });
}

const SELECT_ALL = 'SELECT id, app_id, type, installed_version, catalog_version, update_available, installed_at, subdomain, sso_slug, forward_auth_enabled, health_status, health_checked_at, source, source_url FROM installed_apps';

export async function getAllInstalledApps(): Promise<InstalledApp[]> {
  await ensureTable();
  const raw = await psql(`${SELECT_ALL} ORDER BY installed_at DESC`);
  return parseRows(raw);
}

export async function getInstalledApp(appId: string): Promise<InstalledApp | null> {
  await ensureTable();
  const raw = await psql(`${SELECT_ALL} WHERE app_id = '${appId}' LIMIT 1`);
  const rows = parseRows(raw);
  return rows[0] ?? null;
}

export async function upsertInstalledApp(data: {
  appId: string;
  type: string; // 'native' | 'basic' | 'marketplace' (v2 uses native/basic)
  installedVersion: string;
  subdomain: string;
  ssoSlug?: string | null;
  forwardAuthEnabled?: boolean;
}): Promise<void> {
  await ensureTable();
  const ssoSlug = data.ssoSlug ? `'${data.ssoSlug}'` : 'NULL';
  const faEnabled = data.forwardAuthEnabled ? 'TRUE' : 'FALSE';
  await psql(`
    INSERT INTO installed_apps (app_id, type, installed_version, subdomain, sso_slug, forward_auth_enabled)
    VALUES ('${data.appId}', '${data.type}', '${data.installedVersion}', '${data.subdomain}', ${ssoSlug}, ${faEnabled})
    ON CONFLICT (app_id) DO UPDATE SET
      type = EXCLUDED.type,
      installed_version = EXCLUDED.installed_version,
      subdomain = EXCLUDED.subdomain,
      sso_slug = EXCLUDED.sso_slug,
      forward_auth_enabled = EXCLUDED.forward_auth_enabled
  `);
}

export async function removeInstalledApp(appId: string): Promise<void> {
  await ensureTable();
  await psql(`DELETE FROM installed_apps WHERE app_id = '${appId}'`);
}

export async function updateInstalledAppSubdomain(appId: string, subdomain: string): Promise<void> {
  await ensureTable();
  await psql(`UPDATE installed_apps SET subdomain = '${subdomain}' WHERE app_id = '${appId}'`);
}

export async function updateInstalledVersion(appId: string, version: string): Promise<void> {
  await ensureTable();
  await psql(`UPDATE installed_apps SET installed_version = '${version}', update_available = FALSE WHERE app_id = '${appId}'`);
}

/**
 * Update the source tracking for a URL-installed app.
 */
export async function updateInstalledAppSource(
  appId: string,
  source: 'catalog' | 'url',
  sourceUrl?: string
): Promise<void> {
  await ensureTable();
  const urlSql = sourceUrl ? `'${sourceUrl.replace(/'/g, "''")}'` : 'NULL';
  await psql(`UPDATE installed_apps SET source = '${source}', source_url = ${urlSql} WHERE app_id = '${appId}'`);
}

// ─── Migration from install.json ──────────────────────────────

export async function migrateFromInstallJson(): Promise<number> {
  await ensureTable();

  const existing = await getAllInstalledApps();
  const existingIds = new Set(existing.map((a) => a.appId));

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
    console.log(`[installed-apps] Migrated ${migrated} apps from install.json to DB`);
  }
  return migrated;
}

// ─── Update Detection ─────────────────────────────────────────

/**
 * Fetch the latest version for an app by reading its manifest from its repo.
 * v2: repo is e.g. "potemsla/YE-App-Wiki", manifest is "youeye-app.yaml".
 */
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

/**
 * Fetch latest version from a URL-installed app's manifest.
 * Re-fetches the manifest from the original source_url.
 */
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
 *
 * For apps with `repo`: fetches `youeye-app.yaml` from the app's own repo.
 * For apps with `latestVersion`: uses the catalog-specified version directly.
 * For URL-installed apps without catalog entries: re-fetches the manifest from source_url.
 *
 * Updates the `catalog_version` and `update_available` columns in the DB.
 * Returns the list of apps with available updates.
 */
export async function checkForUpdates(): Promise<InstalledApp[]> {
  await ensureTable();

  let catalog;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    console.error('[installed-apps] Failed to fetch catalog for update check:', err);
    return [];
  }

  const branch = await getEffectiveBranch();
  const installed = await getAllInstalledApps();
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
      // URL-installed custom app — no catalog entry, fetch version from source URL
      catalogVersion = await fetchUrlAppVersion(app.sourceUrl);
    }

    let hasUpdate = false;
    if (catalogVersion && app.installedVersion) {
      try {
        hasUpdate = isNewer(catalogVersion, app.installedVersion);
      } catch {
        // Version comparison failed — treat as no update
        hasUpdate = false;
      }
    }

    // Update DB with current catalog version and update status
    const cvSql = catalogVersion ? `'${catalogVersion}'` : 'NULL';
    await psql(`
      UPDATE installed_apps
      SET catalog_version = ${cvSql}, update_available = ${hasUpdate}
      WHERE app_id = '${app.appId}'
    `);

    if (hasUpdate) {
      appsWithUpdates.push({
        ...app,
        catalogVersion,
        updateAvailable: true,
      });
    }
  }

  return appsWithUpdates;
}

/**
 * Get all apps that have updates available.
 */
export async function getAppsWithUpdatesAvailable(): Promise<InstalledApp[]> {
  await ensureTable();
  const raw = await psql(`${SELECT_ALL} WHERE update_available = TRUE ORDER BY app_id`);
  return parseRows(raw);
}

// ─── Forward-Auth Toggle ─────────────────────────────────────

export async function updateForwardAuthEnabled(appId: string, enabled: boolean): Promise<void> {
  await ensureTable();
  await psql(`UPDATE installed_apps SET forward_auth_enabled = ${enabled} WHERE app_id = '${appId}'`);
}

// ─── Health Status ───────────────────────────────────────────

export async function updateHealthStatus(
  appId: string,
  status: 'healthy' | 'unhealthy' | 'unknown',
): Promise<void> {
  await ensureTable();
  await psql(`UPDATE installed_apps SET health_status = '${status}', health_checked_at = NOW() WHERE app_id = '${appId}'`);
}
