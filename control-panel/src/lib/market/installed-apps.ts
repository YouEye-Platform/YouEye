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

import { writeJSON, statePath } from '@/lib/storage/json-store';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppUpdateExecutorLock } from './update-executor-lock';
import { isAppUpdateReserved } from './update-admission';
import { listInstalledApps, readInstallMetadata } from './metadata';
import { fetchCatalog, isMarketAppUnavailable, resolveCatalogApp } from './catalog';
import { isMarketSourceConsentError } from './source';
import { youeyeRequirementProblem } from './app-format/requires';
import {
  catalogUpdateState,
  classifyAppUpdateRouting,
  hasRecordedCatalogIdentity,
  projectUpdateAvailability,
  recordedCatalogSourceIds,
  recordedSourceAddressChange,
} from './update-routing';
import type { AppManifest, InstallMetadata } from './types';
import { verifyInstalledProductReceipt } from '../releases/product-release';

/** Build version of a native app's accepted product release (null when it has none or it is unreadable). */
function installedProductBuild(appId: string, installMeta: InstallMetadata | null | undefined): string | null {
  const receipt = installMeta?.nativeArtifacts?.find((artifact) => artifact.productRelease)?.productRelease;
  if (!receipt) return null;
  try { return verifyInstalledProductReceipt(receipt, { product: appId }).build.build_version; } catch { return null; }
}

const STORE_PATH = process.env.YOUEYE_INSTALLED_APPS_PATH ?? statePath('installed-apps.json');

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
  appHealthState?: 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown' | 'maintenance';
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
  /**
   * Why the last update check offers no update, when the reason is not "nothing newer". Null when nothing blocks.
   * - `source-changed`: the app's source id now names another market address than the app was installed from
   *   (`recordedSourceAddressChange`).
   * - `source-unavailable`: the app's source is not on this box any more (removed, or a git source from before
   *   0.6.11) or is turned off: the app has no update source until it is switched to one on its page.
   * - `source-not-accepted`: the owner has not accepted the app's custom market.
   * - `requires-newer-youeye`: the market's version of the app needs a newer YouEye than this box runs.
   */
  updateBlocked?: { code: 'source-changed' | 'source-unavailable' | 'source-not-accepted' | 'requires-newer-youeye'; message: string } | null;
  migrationsRequired?: number;
  migrationGates?: Array<{
    fromVersion: string;
    toVersion: string;
    idempotencyKey?: string;
    description?: string;
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

async function loadStore(): Promise<InstalledAppsStore> {
  let fd: number;
  try { fd = openSync(STORE_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { apps: {}, nextId: 1 };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.()
      || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024 * 1024) {
      throw new Error('Installed-app store is corrupt or insecure');
    }
    const value = JSON.parse(readFileSync(fd, 'utf8')) as InstalledAppsStore;
    if (!value || !value.apps || typeof value.apps !== 'object' || Array.isArray(value.apps)
      || !Number.isSafeInteger(value.nextId) || value.nextId < 1
      || Object.entries(value.apps).some(([id, app]) => !app || app.appId !== id
        || !Number.isSafeInteger(app.id) || app.id < 1 || app.id >= value.nextId)) {
      throw new Error('Installed-app store is corrupt or insecure');
    }
    return value;
  } finally { closeSync(fd); }
}

/** Short OS lock around read/modify/write; no catalog or runtime awaits belong here. */
async function mutateStore<T>(mutation: (store: InstalledAppsStore) => T): Promise<T> {
  const directory = path.dirname(STORE_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o022) !== 0) {
    throw new Error('Installed-app store directory is corrupt or insecure');
  }
  // Persistent State is also used by non-sensitive component stores and may
  // legitimately be 0755. Keep this lock's stable inode in its own private
  // directory instead of requiring a permission change to shared State.
  const lockDirectory = path.join(directory, '.installed-apps-lock');
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const started = Date.now();
  let lock: AppUpdateExecutorLock;
  while (true) {
    try {
      lock = AppUpdateExecutorLock.acquire(path.join(lockDirectory, 'store.flock'));
      break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('executor lock is busy')
        || Date.now() - started >= 10_000) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    const current = await loadStore();
    const result = mutation(current);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('Installed-app mutation must not await external work');
    }
    await writeJSON(STORE_PATH, current);
    const fd = openSync(STORE_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return result;
  } finally { lock.release(); }
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
  return mutateStore(s => {
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
  });
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
  return mutateStore(s => {
    const app = s.apps[appId];
    if (!app) return;
    if (provenance.version !== undefined) app.installedVersion = provenance.version;
    if (provenance.tag !== undefined) app.installedTag = provenance.tag;
    if (provenance.branch !== undefined) app.installedBranch = provenance.branch;
    if (provenance.source !== undefined) app.channelSource = provenance.source;
    app.updateAvailable = false;
    app.switchPending = false;
  });
}

/**
 * Record a successful external catalog update without manufacturing native
 * release-channel provenance. Clearing native-channel values is safe only
 * after the app was positively classified and updated through its Market source.
 */
export async function recordCatalogAppUpdate(appId: string, version: string): Promise<void> {
  return mutateStore(s => {
    const app = s.apps[appId];
    if (!app) return;
    Object.assign(app, catalogUpdateState(version));
  });
}

export async function restoreInstalledAppUpdateState(
  appId: string,
  previous: InstalledAppUpdateState,
): Promise<void> {
  return mutateStore(s => {
    const app = s.apps[appId];
    if (!app) throw new Error(`Cannot restore update state for missing app "${appId}"`);
    for (const field of [
      'installedVersion', 'catalogVersion', 'updateAvailable', 'switchPending',
      'installedTag', 'installedBranch', 'channelSource',
      'candidateVersion', 'candidateBranch', 'candidateTag',
    ] as const) {
      if (Object.hasOwn(previous, field)) Object.assign(app, { [field]: previous[field] });
    }
  });
}

export async function removeInstalledApp(appId: string): Promise<void> {
  return mutateStore(s => {
    delete s.apps[appId];
  });
}

export async function updateInstalledAppSubdomain(appId: string, subdomain: string): Promise<void> {
  return mutateStore(s => {
    if (s.apps[appId]) {
      s.apps[appId].subdomain = subdomain;
    }
  });
}

export async function updateInstalledVersion(appId: string, version: string): Promise<void> {
  return mutateStore(s => {
    if (s.apps[appId]) {
      s.apps[appId].installedVersion = version;
      s.apps[appId].updateAvailable = false;
    }
  });
}

export async function updateInstalledAppSource(
  appId: string,
  source: 'catalog' | 'url',
  sourceUrl?: string
): Promise<void> {
  return mutateStore(s => {
    if (s.apps[appId]) {
      s.apps[appId].source = source;
      s.apps[appId].sourceUrl = sourceUrl ?? null;
    }
  });
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

/** The current manifest of an app added by URL (parsed by the one app-format parser); nothing is saved. */
async function fetchUrlAppManifest(sourceId: string): Promise<AppManifest | null> {
  try {
    const { fetchDirectMarketAppUpdate } = await import('./direct-apps');
    return (await fetchDirectMarketAppUpdate(sourceId)).manifest;
  } catch (err) {
    console.warn('[installed-apps] Failed to fetch URL app manifest:', sourceId, err);
    return null;
  }
}

/**
 * Compare each installed app's version against the latest available version.
 * Updates catalogVersion and updateAvailable in the JSON store.
 * Remote reads use detached snapshots; only preview fields merge into current state.
 */
export async function checkForUpdates(): Promise<InstalledApp[]> {
  let catalog = null;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    console.error('[installed-apps] Failed to fetch catalog for update check:', err);
  }

  const s = await loadStore();
  const installed = Object.values(s.apps);
  const baselines = new Map(installed.map(app => [app.appId, structuredClone(app)]));

  const entryMap = new Map((catalog?.apps ?? []).map((entry) => [entry.id, entry]));
  const { getPlatformContext } = await import('./platform-env');
  const platformVersion = (await getPlatformContext()).version;

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
    // Only the app's own recorded source is asked (else the official Market): a check never moves an app to another
    // source, and a source the owner has not accepted is refused like an install.
    const recordedSourceId = recordedCatalogSourceIds(app, installMeta ?? {})[0];
    const defaultEntry = entryMap.get(app.appId);
    if (recordedSourceId?.startsWith('direct:')) {
      sourceManifest = await fetchUrlAppManifest(recordedSourceId);
      catalogVersion = sourceManifest?.version ?? null;
    } else if (recordedSourceId || hasRecordedCatalogIdentity(app, installMeta ?? {}) || defaultEntry) {
      // Nothing is offered, and nothing stale stays on offer, when the app's source cannot be used; the reason is kept.
      const blocked = (code: NonNullable<InstalledApp['updateBlocked']>['code'], message: string, version: string | null = null) => {
        console.warn(`[installed-apps] No update offered for ${app.appId}: ${message}`);
        Object.assign(app, {
          catalogVersion: version, updateAvailable: false, switchPending: false, candidateVersion: null, candidateBranch: null,
          candidateTag: null, updatePath: null, migrationsRequired: 0, migrationGates: [],
          updateBlocked: { code, message },
        } satisfies Partial<InstalledApp>);
        return app;
      };
      try {
        resolvedCatalog = await resolveCatalogApp(app.appId, recordedSourceId);
      } catch (error) {
        if (isMarketSourceConsentError(error) && (error.code === 'source-unavailable' || error.code === 'source-not-accepted')) {
          return blocked(error.code, error.code === 'source-unavailable'
            ? `${error.message}: this app has no update source. Choose one on the app's page.` : error.message);
        }
        // The market's version needs a newer YouEye: it is never offered as an update.
        if (isMarketAppUnavailable(error)) return blocked('requires-newer-youeye', error.message, error.version ?? null);
        throw error;
      }
      // The id may name another market address by now: offer nothing from it, and say why.
      const change = recordedSourceAddressChange({ sourceRepoUrl: installMeta?.sourceRepoUrl ?? app.sourceRepoUrl }, resolvedCatalog.source);
      if (change) return blocked('source-changed', change.message);
      sourceManifest = resolvedCatalog.manifest;
      catalogVersion = sourceManifest.version ?? null;
    }

    const routing = classifyAppUpdateRouting({
      appId: app.appId,
      installed: app,
      installMetadata: installMeta ?? {},
      catalog: resolvedCatalog ? {
        sourceId: resolvedCatalog.source.id,
        entry: resolvedCatalog.entry,
        manifestIntegration: resolvedCatalog.manifest.integration,
      } : null,
    });
    // The resolved source is the app's recorded one, or the official Market for an app that recorded none.
    if (resolvedCatalog && (resolvedCatalog.source.id === recordedSourceId || !recordedSourceId)) {
      app.sourceId = resolvedCatalog.source.id;
      app.sourceName = resolvedCatalog.source.name;
      // A custom market's address is recorded once (the check above keeps the app on it); the official Market has none.
      if (!app.sourceRepoUrl && resolvedCatalog.source.url) app.sourceRepoUrl = resolvedCatalog.source.url;
      app.catalogKey = `${resolvedCatalog.source.id}:app:${app.appId}`;
    }

    // A native app's catalog manifest is its release on the box's channel.
    const candidate = routing.kind === 'channel' && resolvedCatalog?.manifest.version
      ? { version: resolvedCatalog.manifest.version, tag: resolvedCatalog.reference.branch, build: resolvedCatalog.reference.build }
      : null;

    const availability = projectUpdateAvailability({
      routing,
      installedVersion: app.installedVersion,
      installedBuild: routing.kind === 'channel' ? installedProductBuild(app.appId, installMeta) : null,
      catalogVersion,
      candidate,
    });
    catalogVersion = availability.catalogVersion;
    // A version that needs a newer YouEye is never offered as an update.
    const hasUpdate = availability.updateAvailable
      && youeyeRequirementProblem(sourceManifest?.requires, platformVersion) === null;
    app.catalogVersion = availability.catalogVersion;
    app.updateAvailable = hasUpdate;
    app.switchPending = availability.switchPending;
    app.candidateVersion = availability.candidateVersion;
    app.candidateBranch = availability.candidateBranch;
    app.candidateTag = availability.candidateTag;
    app.updatePath = null;
    app.updateBlocked = null;
    app.migrationsRequired = 0;
    app.migrationGates = [];

    if (hasUpdate && catalogVersion && app.installedVersion) {
      app.updatePath = `${app.installedVersion} -> ${catalogVersion}`;
    }

    return app;
  }

  const results = await Promise.all(
    installed.map((app) =>
      processApp(app).catch((err) => {
        console.error('[installed-apps] Update check failed for', app.appId, err);
        return null;
      }),
    ),
  );
  return mergeInstalledAppPreviews(results.filter((app): app is InstalledApp => app !== null)
    .map(preview => ({ baseline: baselines.get(preview.appId)!, preview })));
}

/**
 * A delayed preview cannot publish installed state, security, health or other
 * apps from its old snapshot. Changed installation/source identity invalidates
 * its projection instead of rewinding a concurrent update or resurrecting an app.
 */
export async function mergeInstalledAppPreviews(
  previews: Array<{ baseline: InstalledApp; preview: InstalledApp }>,
): Promise<InstalledApp[]> {
  return mutateStore(current => {
    for (const { baseline, preview } of previews) {
      const latest = current.apps[baseline.appId];
      if (!latest || preview.appId !== baseline.appId || isAppUpdateReserved(baseline.appId)) continue;
      const identity = [
        'id', 'installedAt', 'installedVersion', 'installedTag', 'installedBranch', 'channelSource',
        'source', 'sourceUrl', 'sourceId', 'sourceRepoUrl', 'catalogKey',
      ] as const;
      if (identity.some(field => latest[field] !== baseline[field])
        || preview.installedVersion !== latest.installedVersion) continue;
      for (const field of [
        'catalogVersion', 'updateAvailable', 'switchPending',
        'candidateVersion', 'candidateBranch', 'candidateTag',
        'updatePath', 'updateBlocked', 'migrationsRequired', 'migrationGates',
        'sourceId', 'sourceName', 'sourceRepoUrl', 'catalogKey',
      ] as const) {
        if (Object.hasOwn(preview, field)) Object.assign(latest, { [field]: structuredClone(preview[field]) });
      }
    }
    return Object.values(current.apps).filter(app => app.updateAvailable);
  });
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
  return mutateStore(s => {
    if (s.apps[appId]) {
      s.apps[appId].forwardAuthEnabled = enabled;
    }
  });
}

// ─── Health Status ───────────────────────────────────────────

/** When each app was last checked, in memory: the store is written only when the result changes. */
function healthCheckTimes(): Map<string, string> {
  const registry = globalThis as typeof globalThis & { __youeyeHealthCheckedAt?: Map<string, string> };
  registry.__youeyeHealthCheckedAt ??= new Map();
  return registry.__youeyeHealthCheckedAt;
}

/** The latest health check time of an app: this process's last check, else the stored time of the last change. */
export function latestHealthCheckedAt(appId: string, stored?: string | null): string | null {
  return healthCheckTimes().get(appId) ?? stored ?? null;
}

export async function updateHealthStatus(
  appId: string,
  status: 'healthy' | 'unhealthy' | 'unknown',
  probe?: {
    appHealthState?: 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown' | 'maintenance';
    failingLevel?: 'L1' | 'L2' | 'L3';
    healthDetail?: string | null;
  },
): Promise<void> {
  healthCheckTimes().set(appId, new Date().toISOString());
  // An unchanged result costs no write (the 46 KB store with two fsyncs and a lock, per app, every 30 s before).
  const current = (await loadStore()).apps[appId];
  if (!current || (current.healthStatus === status
    && current.appHealthState === (probe?.appHealthState ?? 'unknown')
    && current.failingLevel === probe?.failingLevel
    && (current.healthDetail ?? null) === (probe?.healthDetail ?? null))) return;
  return mutateStore(s => {
    if (s.apps[appId]) {
      s.apps[appId].healthStatus = status;
      s.apps[appId].healthCheckedAt = new Date().toISOString();
      s.apps[appId].appHealthState = probe?.appHealthState ?? 'unknown';
      s.apps[appId].failingLevel = probe?.failingLevel;
      s.apps[appId].healthDetail = probe?.healthDetail ?? null;
    }
  });
}

export async function updateHealthProbeState(
  appId: string,
  probeState: NonNullable<InstalledApp['healthProbeState']>,
): Promise<void> {
  return mutateStore(s => {
    if (s.apps[appId]) {
      s.apps[appId].healthProbeState = { ...probeState };
    }
  });
}
