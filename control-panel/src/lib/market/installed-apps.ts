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
import { fetchCatalog, fetchUpdatePlanMigrationsFromSource, resolveCatalogApp } from './catalog';
import { parse as parseYAML } from 'yaml';
import { describeUpdatePath, findApplicableMigrations, mergeMigrationSources } from './migration-planner';
import { effectiveChannel, resolveCandidate, getReleaseChannelsConfig, APP_PREFIX } from '@/lib/updates/channels';
import {
  catalogUpdateState,
  classifyAppUpdateRouting,
  hasRecordedCatalogIdentity,
  projectUpdateAvailability,
  recordedCatalogSourceIds,
  repositoriesMatch,
} from './update-routing';
import type { AppManifest } from './types';

const STORE_PATH = statePath('installed-apps.json');

// ─── Types ────────────────────────────────────────────────────

export interface InstalledApp {
  id: number;
  appId: string;
  type: 'native' | 'basic' | 'market';
  installedVersion: string;
  catalogVersion: string | null;
  updateAvailable: boolean;
  /**
   * A pending CHANNEL SWITCH — the app's effective channel resolves to a release
   * on a DIFFERENT branch than what is installed. This is NOT a normal update
   * (the resolved version may even be numerically lower); it is surfaced
   * separately and never auto-applied. Requires an explicit confirm to install.
   */
  switchPending?: boolean;
  installedAt: string;
  subdomain: string;
  ssoSlug: string | null;
  forwardAuthEnabled: boolean;
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  healthCheckedAt: string | null;
  appHealthState?: 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown';
  failingLevel?: 'L1' | 'L2' | 'L3';
  healthDetail?: string | null;
  healthProbeState?: {
    failures: number;
    backoffMs: number;
    capCycles: number;
    lastRestartAt: number;
    healthySince: number | null;
  };
  source: 'catalog' | 'url';
  sourceUrl: string | null;
  catalogKey?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  sourceRepoUrl?: string | null;
  // ─── Provenance (channel-aware) ───────────────────────────
  /** Full release tag the installed version came from (e.g. "f-drawer-v0.5.0.0.0.0.1"). */
  installedTag?: string | null;
  /** Branch the installed version came from (e.g. "main", "f-drawer"). */
  installedBranch?: string | null;
  /** Repo URL the installed version was pulled from. */
  channelSource?: string | null;
  /** Candidate version the effective channel currently resolves to. */
  candidateVersion?: string | null;
  /** Candidate branch the effective channel currently resolves to. */
  candidateBranch?: string | null;
  /** Candidate tag the effective channel currently resolves to. */
  candidateTag?: string | null;
  updatePath?: string | null;
  migrationsRequired?: number;
  migrationGates?: Array<{
    fromVersion: string;
    toVersion: string;
    idempotencyKey?: string;
    description?: string;
    source?: 'manifest' | 'update-plan';
  }>;
}

interface InstalledAppsStore {
  apps: Record<string, InstalledApp>;
  nextId: number;
}

export type InstalledAppUpdateState = Pick<InstalledApp,
  | 'installedVersion'
  | 'catalogVersion'
  | 'updateAvailable'
  | 'switchPending'
  | 'installedTag'
  | 'installedBranch'
  | 'channelSource'
  | 'candidateVersion'
  | 'candidateBranch'
  | 'candidateTag'
>;

// ─── Store Management ─────────────────────────────────────────

let store: InstalledAppsStore | null = null;

async function loadStore(): Promise<InstalledAppsStore> {
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
  /** Catalog version at install time — persisting it here means update
   *  detection never starts from a null baseline (0.5.5 fix) */
  catalogVersion?: string | null;
  subdomain: string;
  ssoSlug?: string | null;
  forwardAuthEnabled?: boolean;
  catalogKey?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  sourceRepoUrl?: string | null;
  /** Provenance recorded at install/update time. */
  installedTag?: string | null;
  installedBranch?: string | null;
  channelSource?: string | null;
}): Promise<void> {
  const s = await loadStore();
  const existing = s.apps[data.appId];

  if (existing) {
    existing.type = data.type as InstalledApp['type'];
    existing.installedVersion = data.installedVersion;
    existing.catalogVersion = data.catalogVersion ?? existing.catalogVersion ?? null;
    existing.subdomain = data.subdomain;
    existing.ssoSlug = data.ssoSlug ?? existing.ssoSlug;
    existing.forwardAuthEnabled = data.forwardAuthEnabled ?? existing.forwardAuthEnabled;
    existing.catalogKey = data.catalogKey ?? existing.catalogKey ?? null;
    existing.sourceId = data.sourceId ?? existing.sourceId ?? null;
    existing.sourceName = data.sourceName ?? existing.sourceName ?? null;
    existing.sourceRepoUrl = data.sourceRepoUrl ?? existing.sourceRepoUrl ?? null;
    if (data.installedTag !== undefined) existing.installedTag = data.installedTag;
    if (data.installedBranch !== undefined) existing.installedBranch = data.installedBranch;
    if (data.channelSource !== undefined) existing.channelSource = data.channelSource;
  } else {
    s.apps[data.appId] = {
      id: s.nextId++,
      appId: data.appId,
      type: data.type as InstalledApp['type'],
      installedVersion: data.installedVersion,
      catalogVersion: data.catalogVersion ?? null,
      updateAvailable: false,
      installedAt: new Date().toISOString(),
      subdomain: data.subdomain,
      ssoSlug: data.ssoSlug ?? null,
      forwardAuthEnabled: data.forwardAuthEnabled ?? false,
      healthStatus: 'unknown',
      healthCheckedAt: null,
      appHealthState: 'unknown',
      healthDetail: null,
      source: 'catalog',
      sourceUrl: null,
      catalogKey: data.catalogKey ?? null,
      sourceId: data.sourceId ?? null,
      sourceName: data.sourceName ?? null,
      sourceRepoUrl: data.sourceRepoUrl ?? null,
      installedTag: data.installedTag ?? null,
      installedBranch: data.installedBranch ?? null,
      channelSource: data.channelSource ?? null,
      updatePath: null,
      migrationsRequired: 0,
      migrationGates: [],
    };
  }

  await saveStore();
}

/**
 * Record provenance for an installed native app after a successful install or
 * update. Called by the install/update flows once the artifact is applied so
 * subsequent channel-aware checks can tell "update within my channel" from
 * "channel switch".
 */
export async function recordAppProvenance(
  appId: string,
  provenance: { version?: string; tag?: string | null; branch?: string | null; source?: string | null },
): Promise<void> {
  const s = await loadStore();
  const app = s.apps[appId];
  if (!app) return;
  if (provenance.version !== undefined) app.installedVersion = provenance.version;
  if (provenance.tag !== undefined) app.installedTag = provenance.tag;
  if (provenance.branch !== undefined) app.installedBranch = provenance.branch;
  if (provenance.source !== undefined) app.channelSource = provenance.source;
  app.updateAvailable = false;
  app.switchPending = false;
  await saveStore();
}

/**
 * Record a successful external catalog update without manufacturing native
 * release-channel provenance. Clearing legacy synthetic values is safe only
 * after the app was positively classified and updated through its Market source.
 */
export async function recordCatalogAppUpdate(appId: string, version: string): Promise<void> {
  const s = await loadStore();
  const app = s.apps[appId];
  if (!app) return;
  Object.assign(app, catalogUpdateState(version));
  await saveStore();
}

export async function restoreInstalledAppUpdateState(
  appId: string,
  previous: InstalledAppUpdateState,
): Promise<void> {
  const s = await loadStore();
  const app = s.apps[appId];
  if (!app) throw new Error(`Cannot restore update state for missing app "${appId}"`);
  Object.assign(app, previous);
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
    // Provisional install/restore metadata is a recovery record, not an
    // installed app. Publishing it here lets background reconciliation race
    // the installer and enforce its intentionally stopped pre-commit state.
    if (meta.lifecycleState !== 'active') continue;
    if (existingIds.has(meta.appId)) continue;

    await upsertInstalledApp({
      appId: meta.appId,
      type: meta.integration || 'basic',
      installedVersion: meta.installedVersion ?? '',
      subdomain: meta.subdomain,
      ssoSlug: meta.ssoSlug,
      catalogKey: meta.catalogKey,
      sourceId: meta.sourceId,
      sourceName: meta.sourceName,
      sourceRepoUrl: meta.sourceRepoUrl,
    });
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[installed-apps] Migrated ${migrated} apps from install.json to JSON store`);
  }
  return migrated;
}

// ─── Update Detection ─────────────────────────────────────────

async function fetchUrlAppVersion(sourceUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'text/yaml, application/yaml, text/plain, */*', 'User-Agent': 'YouEye-Market/1.0' },
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
  let catalog = null;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    console.error('[installed-apps] Failed to fetch catalog for update check:', err);
  }

  const channelsConfig = await getReleaseChannelsConfig();
  const s = await loadStore();
  const installed = Object.values(s.apps);

  const entryMap = new Map<string, { path?: string; file?: string; repo?: string; manifest?: string; latestVersion?: string; integration?: string }>();
  for (const e of catalog?.apps ?? []) {
    entryMap.set(e.id, e);
  }

  // Each installed app's update check is independent (per-app network fetches), so run them
  // in parallel rather than sequentially — N round-trips of latency collapse to ~1.
  async function processApp(app: InstalledApp): Promise<InstalledApp | null> {
    const installMeta = await readInstallMetadata(app.appId);
    if (installMeta?.installedVersion && installMeta.installedVersion !== app.installedVersion) {
      app.installedVersion = installMeta.installedVersion;
      app.updateAvailable = false;
    }
    if (installMeta?.catalogKey && !app.catalogKey) app.catalogKey = installMeta.catalogKey;
    if (installMeta?.sourceId && !app.sourceId) app.sourceId = installMeta.sourceId;
    if (installMeta?.sourceName && !app.sourceName) app.sourceName = installMeta.sourceName;
    if (installMeta?.sourceRepoUrl && !app.sourceRepoUrl) app.sourceRepoUrl = installMeta.sourceRepoUrl;

    let catalogVersion: string | null = null;
    let sourceManifest: AppManifest | null = null;
    let resolvedCatalog: Awaited<ReturnType<typeof resolveCatalogApp>> | null = null;
    const recordedSourceIds = recordedCatalogSourceIds(app, installMeta ?? {});
    const defaultEntry = entryMap.get(app.appId);
    if (recordedSourceIds.length > 0 || hasRecordedCatalogIdentity(app, installMeta ?? {}) || defaultEntry) {
      resolvedCatalog = await resolveCatalogApp(app.appId, recordedSourceIds);
      sourceManifest = resolvedCatalog.manifest;
      catalogVersion = sourceManifest.version ?? resolvedCatalog.entry.latestVersion ?? null;
    } else if (app.source === 'url' && app.sourceUrl) {
      catalogVersion = await fetchUrlAppVersion(app.sourceUrl);
    }

    const routing = classifyAppUpdateRouting({
      appId: app.appId,
      installed: app,
      installMetadata: installMeta ?? {},
      catalog: resolvedCatalog ? {
        sourceId: resolvedCatalog.source.id,
        sourceRepoUrl: resolvedCatalog.source.repo_url,
        sourceRepoUrls: resolvedCatalog.configuredSourceRepoUrls,
        entry: resolvedCatalog.entry,
        manifestIntegration: resolvedCatalog.manifest.integration,
      } : null,
      hasExplicitChannelOverride: !!channelsConfig.apps?.[app.appId],
    });
    if (resolvedCatalog) {
      app.sourceId = resolvedCatalog.source.id;
      app.sourceName = resolvedCatalog.source.name;
      if (!app.sourceRepoUrl || resolvedCatalog.configuredSourceRepoUrls.some(
        (sourceUrl) => repositoriesMatch(app.sourceRepoUrl, sourceUrl),
      )) {
        app.sourceRepoUrl = resolvedCatalog.source.repo_url;
      }
      app.catalogKey = `${resolvedCatalog.source.id}:app:${app.appId}`;
    }

    // ─── Channel-aware resolution ─────────────────────────────
    // Resolve the app's effective channel and its candidate release. For a
    // repo-type native app this drives both the catalog version and the
    // update-vs-switch decision. External catalog records never enter this path.
    let candidate: { version: string; branch: string; tag: string } | null = null;

    if (routing.kind === 'channel') {
      try {
        const ch = await effectiveChannel(APP_PREFIX + app.appId, {
          config: channelsConfig,
          appDefaultSource: routing.channelDefaultSource,
        });
        // Native apps use bare tags (no component prefix). The effective
        // channel already carries the right source (explicit override, else
        // the app's own repo) — do not pass an override here.
        candidate = await resolveCandidate(ch, null);
        if (candidate) {
          catalogVersion = candidate.version;
        }
      } catch (err) {
        console.warn('[installed-apps] Channel resolution failed for', app.appId, err);
      }
    }

    const availability = projectUpdateAvailability({
      routing,
      installedVersion: app.installedVersion,
      installedBranch: app.installedBranch,
      catalogVersion,
      candidate,
    });
    catalogVersion = availability.catalogVersion;
    const hasUpdate = availability.updateAvailable;
    app.catalogVersion = availability.catalogVersion;
    app.updateAvailable = availability.updateAvailable;
    app.switchPending = availability.switchPending;
    app.candidateVersion = availability.candidateVersion;
    app.candidateBranch = availability.candidateBranch;
    app.candidateTag = availability.candidateTag;
    app.updatePath = null;
    app.migrationsRequired = 0;
    app.migrationGates = [];

    if (hasUpdate && catalogVersion && app.installedVersion) {
      try {
        if (sourceManifest) {
          const durablePlan = await fetchUpdatePlanMigrationsFromSource(
            app.appId,
            resolvedCatalog?.source.id || app.sourceId || installMeta?.sourceId || undefined,
          );
          const allMigrations = mergeMigrationSources(sourceManifest.update?.migrations || [], durablePlan.migrations);
          const applicableMigrations = findApplicableMigrations(
            allMigrations,
            app.installedVersion,
            catalogVersion,
            installMeta?.appliedMigrations,
          );

          app.updatePath = describeUpdatePath(app.installedVersion, catalogVersion, applicableMigrations);
          app.migrationsRequired = applicableMigrations.length;
          app.migrationGates = applicableMigrations.map((migration) => ({
            fromVersion: migration.fromVersion,
            toVersion: migration.toVersion,
            idempotencyKey: migration.idempotencyKey,
            description: migration.description,
            source: migration.source,
          }));
        }
      } catch (err) {
        console.warn('[installed-apps] Failed to compute migration preview:', app.appId, err);
        app.updatePath = `${app.installedVersion} -> ${catalogVersion}`;
      }
    }

    return hasUpdate ? { ...app } : null;
  }

  const results = await Promise.all(
    installed.map((app) =>
      processApp(app).catch((err) => {
        console.error('[installed-apps] Update check failed for', app.appId, err);
        return null;
      }),
    ),
  );
  const appsWithUpdates = results.filter((a): a is InstalledApp => a !== null);

  await saveStore();
  return appsWithUpdates;
}

export async function getAppsWithUpdatesAvailable(): Promise<InstalledApp[]> {
  const s = await loadStore();
  return Object.values(s.apps).filter(a => a.updateAvailable).sort((a, b) => a.appId.localeCompare(b.appId));
}

/**
 * Apps whose effective channel resolves to a release on a DIFFERENT branch than
 * what is installed (a pending channel switch). These are never plain updates —
 * they require an explicit confirmed switch to apply.
 */
export async function getAppsWithSwitchPending(): Promise<InstalledApp[]> {
  const s = await loadStore();
  return Object.values(s.apps).filter(a => a.switchPending).sort((a, b) => a.appId.localeCompare(b.appId));
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
  probe?: {
    appHealthState?: 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown';
    failingLevel?: 'L1' | 'L2' | 'L3';
    healthDetail?: string | null;
  },
): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].healthStatus = status;
    s.apps[appId].healthCheckedAt = new Date().toISOString();
    s.apps[appId].appHealthState = probe?.appHealthState ?? 'unknown';
    s.apps[appId].failingLevel = probe?.failingLevel;
    s.apps[appId].healthDetail = probe?.healthDetail ?? null;
    await saveStore();
  }
}

export async function updateHealthProbeState(
  appId: string,
  probeState: NonNullable<InstalledApp['healthProbeState']>,
): Promise<void> {
  const s = await loadStore();
  if (s.apps[appId]) {
    s.apps[appId].healthProbeState = { ...probeState };
    await saveStore();
  }
}
