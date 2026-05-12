/**
 * Unified Apps API
 *
 * GET /api/apps/unified
 *
 * Returns every YouEye service in a single response with:
 *  - Static definition (from definitions.ts)
 *  - Live container status (from Incus)
 *  - Version info for Spine-managed components (from Spine API)
 *  - OCI update availability (from digest cache)
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { incusRequest } from '@/lib/incus/server';
import { spineClient } from '@/lib/spine/client';
import { APP_DEFINITIONS } from '@/lib/apps/definitions';
import {
  getAllCachedUpdates,
  getLastCheckedAt,
  isCheckInProgress,
} from '@/lib/apps/update-cache';
import {
  checkLxdAppUpdate,
  type LxdUpdateResult,
} from '@/lib/apps/lxd-updates';
import { getAllHealthStatuses, getLastHealthCheckAt } from '@/lib/market/health-checker';
import { listInstalledApps } from '@/lib/market/metadata';
import { getAllInstalledApps } from '@/lib/market/installed-apps';
import { fetchManifest } from '@/lib/market/catalog';

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
  /** OCI update available */
  updateAvailable: boolean;
  /** Human-readable update info */
  updateInfo?: string;
  /** Links to existing management pages */
  managementLinks?: Array<{ label: string; href: string }>;
  /** Health check status for marketplace/native apps */
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
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
    const [instancesResp, spineStatus, spineUpdates, marketInstalled, dbInstalledApps] = await Promise.allSettled([
      incusRequest<string[]>('GET', '/1.0/instances'),
      spineClient.status(),
      spineClient.checkUpdates(),
      listInstalledApps(),
      getAllInstalledApps(),
    ]);

    const instancePaths =
      instancesResp.status === 'fulfilled' ? instancesResp.value.metadata ?? [] : [];
    const existingNames = new Set(
      instancePaths.map((p: string) => p.split('/').pop() ?? '')
    );

    const status = spineStatus.status === 'fulfilled' ? spineStatus.value : null;
    const updates = spineUpdates.status === 'fulfilled' ? spineUpdates.value : null;
    const installed = marketInstalled.status === 'fulfilled' ? marketInstalled.value : [];
    const dbApps = dbInstalledApps.status === 'fulfilled' ? dbInstalledApps.value : [];
    const dbAppsMap = new Map(dbApps.map((a) => [a.appId, a]));

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

    // Build update info from cache
    const ociUpdates = getAllCachedUpdates();

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

    // Get health statuses for marketplace apps
    const healthStatuses = getAllHealthStatuses();
    const lastHealthCheck = getLastHealthCheckAt();

    // Build the unified list
    const apps: UnifiedApp[] = APP_DEFINITIONS.map((def) => {
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

      // Version info for Spine-managed components
      let version: string | undefined;
      if (def.id === 'spine' && status) version = status.spine?.version;
      if (def.id === 'incus' && status) version = status.incus?.version;
      if (def.id === 'control-panel' && status) version = status.control_panel?.version;

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

      // Spine-managed update detection
      if (def.updatedBy === 'spine' && updates) {
        if (def.id === 'spine' && updates.spine?.available) {
          updateAvailable = true;
          updateInfo = `${updates.spine.current} → ${updates.spine.latest}`;
        }
        if (def.id === 'control-panel' && updates.control?.available) {
          updateAvailable = true;
          updateInfo = `${updates.control.current} → ${updates.control.latest}`;
        }
        if (def.id === 'incus' && updates.incus?.upgradeable) {
          updateAvailable = true;
          updateInfo = 'System package upgrade available';
        }
        if (def.id === 'host-system' && updates.system && updates.system.upgradeable_count > 0) {
          updateAvailable = true;
          updateInfo = `${updates.system.upgradeable_count} packages upgradeable`;
        }
      }

      // OCI update detection from digest cache (only for non-LXD apps)
      if (def.updatedBy === 'control-panel' && !lxdResult) {
        const ociResult = ociUpdates.get(def.id);
        if (ociResult?.hasUpdate) {
          updateAvailable = true;
          updateInfo = 'New image available';
        }
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
        updateAvailable,
        updateInfo,
        managementLinks: def.managementLinks,
        healthStatus: healthStatuses[def.id] ?? undefined,
        healthCheckedAt: lastHealthCheck,
      };
    });

    // ── Marketplace apps: merge installed apps not in APP_DEFINITIONS ──────
    const definedContainers = new Set(
      apps.flatMap((a) => a.containers.map((c) => c.name))
    );

    const filteredMarket = installed.filter((meta) => {
      const names = meta.containers.map((c: any) =>
        typeof c === 'string' ? c : c.containerName
      );
      return !names.some((n: string) => definedContainers.has(n));
    });

    // Fetch container state for marketplace containers (not yet in containerStateMap)
    const marketContainerNames = filteredMarket.flatMap((meta) =>
      meta.containers.map((c: any) => typeof c === 'string' ? c : c.containerName)
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

    const marketApps: UnifiedApp[] = filteredMarket.map((meta, i) => {
      const dbEntry = dbAppsMap.get(meta.appId);
      const manifest = manifestResults[i].status === 'fulfilled'
        ? manifestResults[i].value
        : null;

      const containers: ContainerInfo[] = meta.containers.map((c: any) => {
        const name = typeof c === 'string' ? c : c.containerName;
        const state = containerStateMap.get(name);
        return {
          name,
          status: state?.status ?? 'not-found',
          canControl: true,
          ip: state?.ip,
        };
      });

      const containerStatuses = containers.map((c) => c.status);

      return {
        id: meta.appId,
        displayName: manifest?.metadata.name || meta.appId,
        description: manifest?.metadata.description || 'Marketplace app',
        icon: manifest?.metadata.icon || 'Package',
        category: 'user' as const,
        type: 'docker-lxd',
        containers,
        updatedBy: 'control-panel' as const,
        version: dbEntry?.installedVersion ?? undefined,
        status: aggregateStatus(containerStatuses),
        updateAvailable: dbEntry?.updateAvailable ?? false,
        updateInfo: dbEntry?.updateAvailable && dbEntry.catalogVersion
          ? `${dbEntry.installedVersion} → ${dbEntry.catalogVersion}`
          : undefined,
        healthStatus: healthStatuses[meta.appId] ?? undefined,
        healthCheckedAt: lastHealthCheck,
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
