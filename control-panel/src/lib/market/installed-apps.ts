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
import { fetchCatalog, fetchFile, fetchRepoFile, getEffectiveBranch } from './catalog';
import { parseAppRef } from './parser';
import { parse as parseYAML } from 'yaml';
import { isNewer } from '@/lib/version';

const POSTGRES_CONTAINER = 'youeye-postgres';

// ─── Types ────────────────────────────────────────────────────

export interface InstalledApp {
  id: number;
  appId: string;
  type: 'native' | 'marketplace';
  installedVersion: string;
  catalogVersion: string | null;
  updateAvailable: boolean;
  installedAt: string;
  subdomain: string;
  ssoSlug: string | null;
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
      sso_slug TEXT
    )
  `);
  tableCreated = true;
}

// ─── CRUD Operations ──────────────────────────────────────────

function parseRows(raw: string): InstalledApp[] {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const [id, appId, type, installedVersion, catalogVersion, updateAvailable, installedAt, subdomain, ssoSlug] = line.split('|');
    return {
      id: parseInt(id, 10),
      appId,
      type: type as 'native' | 'marketplace',
      installedVersion,
      catalogVersion: catalogVersion || null,
      updateAvailable: updateAvailable === 't',
      installedAt,
      subdomain,
      ssoSlug: ssoSlug || null,
    };
  });
}

const SELECT_ALL = 'SELECT id, app_id, type, installed_version, catalog_version, update_available, installed_at, subdomain, sso_slug FROM installed_apps';

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
  type: 'native' | 'marketplace';
  installedVersion: string;
  subdomain: string;
  ssoSlug?: string | null;
}): Promise<void> {
  await ensureTable();
  const ssoSlug = data.ssoSlug ? `'${data.ssoSlug}'` : 'NULL';
  await psql(`
    INSERT INTO installed_apps (app_id, type, installed_version, subdomain, sso_slug)
    VALUES ('${data.appId}', '${data.type}', '${data.installedVersion}', '${data.subdomain}', ${ssoSlug})
    ON CONFLICT (app_id) DO UPDATE SET
      type = EXCLUDED.type,
      installed_version = EXCLUDED.installed_version,
      subdomain = EXCLUDED.subdomain,
      sso_slug = EXCLUDED.sso_slug
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
 * Adds source and source_url columns if they don't exist (schema migration).
 */
export async function updateInstalledAppSource(
  appId: string,
  source: 'catalog' | 'url',
  sourceUrl?: string
): Promise<void> {
  await ensureTable();

  // Add columns if they don't exist (safe migration)
  try {
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'catalog'`);
    await psql(`ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS source_url TEXT`);
  } catch {
    // Columns may already exist
  }

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
      type: meta.type ?? 'marketplace',
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
 * Fetch the latest version for a native app by reading youeye-app.yaml
 * from the native app's own repo (resolved via the app-ref pointer in AppMarket).
 *
 * Returns the version string, or null if the repo is unreachable or the
 * manifest doesn't contain a version field.
 */
async function fetchNativeAppVersion(
  nativeRefFile: string,
  branch: string
): Promise<string | null> {
  try {
    // Step 1: Fetch the app-ref pointer from the AppMarket catalog
    const refYaml = await fetchFile(nativeRefFile, branch);
    const ref = parseAppRef(refYaml);

    // Step 2: Fetch youeye-app.yaml from the native app's own repo
    const [owner, repoName] = ref.repo.split('/');
    const manifestYaml = await fetchRepoFile(owner, repoName, ref.manifest, branch);
    const parsed = parseYAML(manifestYaml);

    return parsed?.version ?? null;
  } catch (err) {
    console.warn('[installed-apps] Failed to fetch native app version from repo:', err);
    return null;
  }
}

/**
 * Compare each installed app's version against the latest available version.
 *
 * For external/marketplace apps: uses `latestVersion` from the catalog entry.
 * For native apps: fetches `youeye-app.yaml` from the native app's own repo
 * (resolved via the app-ref pointer in the AppMarket catalog) to get the
 * authoritative version.
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

  // Build lookup maps for native and external entries
  const nativeEntryMap = new Map(catalog.native.map((e) => [e.id, e]));
  const externalEntryMap = new Map(catalog.external.map((e) => [e.id, e]));

  for (const app of installed) {
    let catalogVersion: string | null = null;

    const nativeEntry = nativeEntryMap.get(app.appId);
    const externalEntry = externalEntryMap.get(app.appId);

    if (nativeEntry) {
      // Native app: fetch version from the app's own repo
      catalogVersion = await fetchNativeAppVersion(nativeEntry.file, branch);
    } else if (externalEntry) {
      // External/marketplace app: use latestVersion from catalog
      catalogVersion = externalEntry.latestVersion ?? null;
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
