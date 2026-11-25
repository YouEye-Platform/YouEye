/**
 * Unified Apps API
 *
 * GET /api/apps/unified
 *
 * Returns every YouEye service in a single response with:
 *  - Static definition (from definitions.ts)
 *  - Live container status (from Incus)
 *  - Version info: Spine, the Control Panel and the UI show the installed System release's version; Incus as Spine
 *    reports it
 *  - Update availability (Market apps: the installed-app records; UI and Pointer: the LXD check; core containers:
 *    their pinned images)
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { incusRequest } from '@/lib/incus/server';
import { spineClient } from '@/lib/spine/client';
import { installedRelease, releasePartVersion } from '@/lib/releases/installed-release';
import { APP_DEFINITIONS } from '@/lib/apps/definitions';
import { getLastCheckedAt, isCheckInProgress } from '@/lib/apps/update-cache';
import {
  checkLxdAppUpdate,
  type LxdUpdateResult,
} from '@/lib/apps/lxd-updates';
import { listReadableInstalledApps } from '@/lib/market/metadata';
import { getAllInstalledApps, latestHealthCheckedAt } from '@/lib/market/installed-apps';
import { fetchManifest } from '@/lib/market/catalog';
import { planSystemUpdates, type SystemUpdatePlan } from '@/lib/infrastructure/system-updater';
import type { UpdateBlocked } from '@/lib/market/types';

// ─── Response types ───────────────────────────────────────────────────────────

export interface ContainerInfo {
  name: string;
  status: string; // running | stopped | frozen | error | not-found
  canControl: boolean;
  ip?: string;
}

export interface UnifiedApp {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: 'system' | 'infrastructure' | 'user';
  type: string;
  containers: ContainerInfo[];
  updatedBy: 'control-panel' | 'spine';
  /** Version string when available */
  version?: string;
  /** Overall status derived from container states */
  status: 'running' | 'stopped' | 'partial' | 'not-installed' | 'unknown';
  /** False when an installed user app was intentionally turned off */
  enabled?: boolean;
  desiredState?: 'running' | 'stopped';
  serviceCredentialState?: 'pending' | 'ready' | 'revoked';
  /** Its removal stopped after the credential was revoked: removing it again finishes it (YE-225) */
  removalUnfinished?: boolean;
  databaseMode?: 'shared' | 'own' | 'none';
  /** An update is available */
  updateAvailable: boolean;
  /** Human-readable update info */
  updateInfo?: string;
  /** A Market app that gets no updates, and why (its source is gone, not accepted, or the new version needs a newer YouEye). */
  updateBlocked?: UpdateBlocked | null;
  /** True for Caddy/Pi-Hole/Postgres: tracked against the images pinned by this release */
  systemManaged?: boolean;
  /** Links to existing management pages */
  managementLinks?: Array<{ label: string; href: string }>;
  /** Health check status for Market-installed/native apps */
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  appHealthState?: 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown' | 'maintenance';
  failingLevel?: 'L1' | 'L2' | 'L3';
  healthDetail?: string | null;
  autoRestart?: boolean;
  /** Per-app release channel key. Omitted for external and infrastructure apps. */
  /** Last health check timestamp */
  healthCheckedAt?: string | null;
}

export interface UnifiedAppsResponse {
  apps: UnifiedApp[];
  lastCheckedAt: string | null;
  checkInProgress: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive an aggregate status from individual container statuses */
function aggregateStatus(
  containerStatuses: string[]
): 'running' | 'stopped' | 'partial' | 'not-installed' | 'unknown' {
  if (containerStatuses.length === 0) return 'unknown';

  const running = containerStatuses.filter((s) => s === 'running').length;
  const total = containerStatuses.length;

  if (running === total) return 'running';
  if (running === 0) {
    if (containerStatuses.every((s) => s === 'not-found')) return 'not-installed';
    return 'stopped';
  }
  return 'partial';
}

/** Get the global IPv4 address from container state network info */
function extractIP(stateMetadata: Record<string, unknown>): string | undefined {
  const network = stateMetadata.network as Record<string, unknown> | undefined;
  if (!network) return undefined;

  const eth0 = network.eth0 as {
    addresses?: Array<{ family: string; address: string; scope: string }>;
  } | undefined;
  if (!eth0?.addresses) return undefined;

  for (const addr of eth0.addresses) {
    if (addr.family === 'inet' && addr.scope === 'global') return addr.address;
  }
  return undefined;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parallel data fetches
    const [instancesResp, spineStatus, marketInstalled, dbInstalledApps, systemPlansResult, releaseResult] = await Promise.allSettled([
      incusRequest<string[]>('GET', '/1.0/instances'),
      spineClient.status(),
      listReadableInstalledApps(),
      getAllInstalledApps(),
      planSystemUpdates(),
      installedRelease(),
    ]);
    const release = releaseResult.status === 'fulfilled' ? releaseResult.value : null;

    const instancePaths =
      instancesResp.status === 'fulfilled' ? instancesResp.value.metadata ?? [] : [];
    const existingNames = new Set(
      instancePaths.map((p: string) => p.split('/').pop() ?? '')
    );

    const status = spineStatus.status === 'fulfilled' ? spineStatus.value : null;
    const installed = marketInstalled.status === 'fulfilled' ? marketInstalled.value : [];
    const dbApps = dbInstalledApps.status === 'fulfilled' ? dbInstalledApps.value : [];
    const dbAppsMap = new Map(dbApps.map((a) => [a.appId, a]));

    // Caddy/Pi-Hole/Postgres are tracked against the images pinned by this
    // release, not the moving-tag OCI checker. Degrade gracefully if Incus
    // cannot be read — never 500 the Apps page.
    const systemPlanById = new Map<string, SystemUpdatePlan>();
    if (systemPlansResult.status === 'fulfilled') {
      for (const p of systemPlansResult.value) systemPlanById.set(p.id, p);
    } else {
      console.error('[/api/apps/unified] system update plan failed (degrading):', systemPlansResult.reason);
    }

    // Fetch state for every known container in parallel
    const allContainerNames = APP_DEFINITIONS.flatMap((a) =>
      a.containers.map((c) => c.name)
    );

    const stateResults = await Promise.allSettled(
      allContainerNames.map(async (name) => {
        if (!existingNames.has(name)) return { name, status: 'not-found' as const };
        try {
          const resp = await incusRequest<Record<string, unknown>>(
            'GET',
            `/1.0/instances/${name}/state`
          );
          const meta = resp.metadata ?? {};
          return {
            name,
            status: ((meta.status as string) ?? 'unknown').toLowerCase(),
            ip: extractIP(meta),
          };
        } catch {
          return { name, status: 'unknown' as const };
        }
      })
    );

    const containerStateMap = new Map<
      string,
      { name: string; status: string; ip?: string }
    >();
    for (const r of stateResults) {
      if (r.status === 'fulfilled') {
        containerStateMap.set(r.value.name, r.value);
      }
    }

    // Fetch LXD app version + update info in parallel
    const lxdApps = APP_DEFINITIONS.filter(
      (d) => d.lxdConfig && d.containers.length > 0
    );
    const lxdResults = await Promise.allSettled(
      lxdApps.map((d) => checkLxdAppUpdate(d))
    );
    const lxdUpdates = new Map<string, LxdUpdateResult>();
    lxdResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        lxdUpdates.set(lxdApps[i].id, r.value);
      }
    });

    // Build the unified list
    const apps: UnifiedApp[] = APP_DEFINITIONS.map((def) => {
      const installedApp = dbAppsMap.get(def.id);
      // Container info
      const containers: ContainerInfo[] = def.containers.map((c) => {
        const state = containerStateMap.get(c.name);
        return {
          name: c.name,
          status: state?.status ?? 'not-found',
          canControl: c.canControl,
          ip: state?.ip,
        };
      });

      const containerStatuses = containers.map((c) => c.status);

      // Spine, the Control Panel and the UI: the installed release's version, never a build name baked into them.
      let version: string | undefined = releasePartVersion(def.id, release);
      if (def.id === 'incus' && status) version = status.incus?.version;

      // Update info
      let updateAvailable = false;
      let updateInfo: string | undefined;

      // LXD app version + update detection (generic for any app with lxdConfig)
      const lxdResult = lxdUpdates.get(def.id);
      if (lxdResult) {
        if (lxdResult.installedVersion) {
          version = lxdResult.installedVersion;
        }
        if (lxdResult.hasUpdate && lxdResult.installedVersion && lxdResult.latestVersion) {
          updateAvailable = true;
          updateInfo = `${lxdResult.installedVersion} → ${lxdResult.latestVersion}`;
        }
      }

      // Spine, the Control Panel and the UI update with the System release (Settings → System).

      // Caddy/Pi-Hole/Postgres: version + update come from the pinned-image
      // plan, never the moving-tag checker.
      const systemPlan = def.systemImageId ? systemPlanById.get(def.systemImageId) : undefined;
      if (systemPlan) {
        version = systemPlan.currentVersion ?? systemPlan.recordedVersion ?? version;
        updateAvailable = systemPlan.updateAvailable && systemPlan.trackingStatus === 'tracked';
        updateInfo = updateAvailable
          ? `${systemPlan.currentVersion ?? '?'} → ${systemPlan.desiredVersion}`
          : undefined;
      }

      return {
        id: def.id,
        displayName: def.displayName,
        description: def.description,
        icon: def.icon,
        category: def.category,
        type: def.type,
        containers,
        updatedBy: def.updatedBy,
        version,
        status: def.containers.length > 0 ? aggregateStatus(containerStatuses) : 'running',
        enabled: true,
        desiredState: 'running',
        updateAvailable,
        updateInfo,
        systemManaged: !!def.systemImageId,
        managementLinks: def.managementLinks,
        healthStatus: installedApp?.healthStatus,
        appHealthState: installedApp?.appHealthState,
        failingLevel: installedApp?.failingLevel,
        healthDetail: installedApp?.healthDetail ?? null,
        healthCheckedAt: installedApp ? latestHealthCheckedAt(installedApp.appId, installedApp.healthCheckedAt) : null,
      };
    });

    // ── Market-installed apps: merge installed apps not in APP_DEFINITIONS ──────
    const definedContainers = new Set(
      apps.flatMap((a) => a.containers.map((c) => c.name))
    );

    const filteredMarket = installed.filter((meta) => {
      const names = meta.containers.map((c: any) =>
        c.containerName
      );
      return !names.some((n: string) => definedContainers.has(n));
    });

    // Fetch container state for Market-installed containers (not yet in containerStateMap)
    const marketContainerNames = filteredMarket.flatMap((meta) =>
      meta.containers.map((c: any) => c.containerName)
    );
    const marketStateResults = await Promise.allSettled(
      marketContainerNames.map(async (name) => {
        if (!existingNames.has(name)) return { name, status: 'not-found' as const };
        try {
          const resp = await incusRequest<Record<string, unknown>>(
            'GET',
            `/1.0/instances/${name}/state`
          );
          const meta = resp.metadata ?? {};
          return {
            name,
            status: ((meta.status as string) ?? 'unknown').toLowerCase(),
            ip: extractIP(meta),
          };
        } catch {
          return { name, status: 'unknown' as const };
        }
      })
    );
    for (const r of marketStateResults) {
      if (r.status === 'fulfilled') {
        containerStateMap.set(r.value.name, r.value);
      }
    }

    // Best-effort manifest lookup for display names / icons
    const manifestResults = await Promise.allSettled(
      filteredMarket.map((meta) => fetchManifest(meta.appId))
    );

    // An app whose removal stopped after its credential was revoked (YE-225): Settings offers to finish the removal.
    const { removalUnfinished } = await import('@/lib/apps/unfinished-removal');
    const unfinishedRemovals = new Set((await Promise.all(filteredMarket
      .filter((meta) => meta.serviceCredentialState === 'pending')
      .map(async (meta) => (await removalUnfinished(meta)) ? meta.appId : null))).filter(Boolean));
    const marketApps: UnifiedApp[] = filteredMarket.map((meta, i) => {
      const dbEntry = dbAppsMap.get(meta.appId);
      const catV = dbEntry?.catalogVersion;
      const insV = dbEntry?.installedVersion;
      // The shared Market checker has already classified the exact recorded
      // source versus native channel and projected update/switch state. Do not
      // manufacture a different answer from version numbers alone here: after
      // a Market-source change, a numerically newer manifest is not actionable
      // until the installed app is explicitly switched to that source.
      const marketUpdate = dbEntry?.updateAvailable === true;
      const manifest = manifestResults[i].status === 'fulfilled'
        ? manifestResults[i].value
        : null;

      const containers: ContainerInfo[] = meta.containers.map((c: any) => {
        const name = c.containerName;
        const state = containerStateMap.get(name);
        return {
          name,
          status: state?.status ?? 'not-found',
          canControl: true,
          ip: state?.ip,
        };
      });

      const containerStatuses = containers.map((c) => c.status);
      const enabled = meta.enabled !== false && meta.desiredState !== 'stopped';
      const status = enabled ? aggregateStatus(containerStatuses) : 'stopped';

      return {
        id: meta.appId,
        displayName: manifest?.metadata.name || meta.appId,
        description: manifest?.metadata.description || 'Market app',
        icon: manifest?.metadata.iconUrl || manifest?.metadata.icon || 'Package',
        category: 'user' as const,
        type: 'docker-lxd',
        containers,
        updatedBy: 'control-panel' as const,
        version: dbEntry?.installedVersion ?? undefined,
        status,
        enabled,
        desiredState: enabled ? 'running' as const : 'stopped' as const,
        serviceCredentialState: meta.serviceCredentialState,
        ...(unfinishedRemovals.has(meta.appId) ? { removalUnfinished: true } : {}),
        databaseMode: meta.databaseMode ?? 'none',
        updateAvailable: marketUpdate,
        updateInfo: marketUpdate && catV ? `${insV} → ${catV}` : undefined,
        updateBlocked: dbEntry?.updateBlocked ?? null,
        healthStatus: dbEntry?.healthStatus,
        appHealthState: dbEntry?.appHealthState,
        failingLevel: dbEntry?.failingLevel,
        healthDetail: dbEntry?.healthDetail ?? null,
        healthCheckedAt: dbEntry ? latestHealthCheckedAt(dbEntry.appId, dbEntry.healthCheckedAt) : null,
        autoRestart: meta.autoRestart !== false,
      };
    });

    const response: UnifiedAppsResponse = {
      apps: [...apps, ...marketApps],
      lastCheckedAt: getLastCheckedAt(),
      checkInProgress: isCheckInProgress(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[/api/apps/unified] Error:', error);
    return NextResponse.json(
      { error: 'Failed to load apps', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
