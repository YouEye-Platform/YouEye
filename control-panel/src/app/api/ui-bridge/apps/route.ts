/**
 * UI Bridge: Apps
 *
 * GET /api/ui-bridge/apps          — all apps with versions, status, update info
 * GET /api/ui-bridge/apps?refresh=true — force refresh update check first
 *
 * Reuses the unified apps API and update cache.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { incusRequest } from '@/lib/incus/server';
import { spineClient } from '@/lib/spine/client';
import { APP_DEFINITIONS } from '@/lib/apps/definitions';
import {
  getAllCachedUpdates,
  getLastCheckedAt,
  isCheckInProgress,
} from '@/lib/apps/update-cache';
import { listInstalledApps } from '@/lib/market/metadata';
import { getAllInstalledApps } from '@/lib/market/installed-apps';
import { fetchManifest } from '@/lib/market/catalog';
import { refreshVersionCheck } from '@/lib/market/version-checker';
import { isNewer } from '@/lib/version';
import { getAllCachedLxdUpdates } from '@/lib/apps/lxd-updates';
import { planSystemUpdates, type SystemUpdatePlan } from '@/lib/infrastructure/system-updater';

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

function aggregateStatus(
  statuses: string[]
): 'running' | 'stopped' | 'partial' | 'not-installed' | 'unknown' {
  if (statuses.length === 0) return 'unknown';
  const running = statuses.filter((s) => s === 'running').length;
  if (running === statuses.length) return 'running';
  if (running === 0) {
    if (statuses.every((s) => s === 'not-found')) return 'not-installed';
    return 'stopped';
  }
  return 'partial';
}

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    // Optional force refresh
    const refresh = request.nextUrl.searchParams.get('refresh') === 'true';
    if (refresh) {
      // refreshVersionCheck() runs the market catalog check AND the infra (OCI/LXD)
      // digest check in one pass, so a single refresh covers everything.
      await refreshVersionCheck();
    }

    // Parallel data fetches
    const [instancesResp, spineStatus, spineUpdates, marketInstalled, dbInstalledApps, systemPlansResult] = await Promise.allSettled([
      incusRequest<string[]>('GET', '/1.0/instances'),
      spineClient.status(),
      spineClient.checkUpdates(),
      listInstalledApps(),
      getAllInstalledApps(),
      planSystemUpdates(),
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

    const systemPlanById = new Map<string, SystemUpdatePlan>();
    if (systemPlansResult.status === 'fulfilled') {
      for (const p of systemPlansResult.value) systemPlanById.set(p.id, p);
    } else {
      console.error('[/api/ui-bridge/apps] system update plan failed (degrading):', systemPlansResult.reason);
    }

    // Container state
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

    const containerStateMap = new Map<string, { name: string; status: string; ip?: string }>();
    for (const r of stateResults) {
      if (r.status === 'fulfilled') {
        containerStateMap.set(r.value.name, r.value);
      }
    }

    const ociUpdates = getAllCachedUpdates();
    const lxdUpdates = getAllCachedLxdUpdates();

    // Build unified list from APP_DEFINITIONS
    // Filter out user-category apps whose containers don't exist (not installed)
    const apps = APP_DEFINITIONS
      .map((def) => {
        const containers = def.containers.map((c) => {
          const state = containerStateMap.get(c.name);
          return {
            name: c.name,
            status: state?.status ?? 'not-found',
            ip: state?.ip,
          };
        });

        let version: string | undefined;
        if (def.id === 'spine' && status) version = status.spine?.version;
        if (def.id === 'incus' && status) version = status.incus?.version;
        if (def.id === 'control-panel' && status) version = status.control_panel?.version;
        if (def.id === 'ui' && status) version = status.ui?.version;

        let updateAvailable = false;
        let updateInfo: string | undefined;

        if (def.updatedBy === 'spine' && updates) {
          if (def.id === 'spine' && updates.spine?.available) {
            updateAvailable = true;
            updateInfo = `${updates.spine.current} → ${updates.spine.latest}`;
          }
          if (def.id === 'control-panel' && updates.control?.available) {
            updateAvailable = true;
            updateInfo = `${updates.control.current} → ${updates.control.latest}`;
          }
          if (def.id === 'host-system' && updates.system?.upgradeable_count) {
            updateAvailable = true;
            updateInfo = `${updates.system.upgradeable_count} package${updates.system.upgradeable_count !== 1 ? 's' : ''} upgradeable`;
          }
          // Incus updates disabled for now
        }

        // Market system apps (Caddy/Pi-Hole/Postgres): tracked via the pinned
        // Market system manifests, not the moving-tag OCI checker.
        const systemPlan = def.marketSystemId ? systemPlanById.get(def.marketSystemId) : undefined;
        if (systemPlan) {
          version = systemPlan.currentVersion ?? systemPlan.recordedVersion ?? version;
          if (systemPlan.updateAvailable && systemPlan.trackingStatus === 'tracked') {
            updateAvailable = true;
            updateInfo = `${systemPlan.currentVersion ?? '?'} → ${systemPlan.desiredVersion}`;
          }
        }

        // Check LXD native app updates (Search, Cinema, Weather, etc.)
        if (def.lxdConfig && !updateAvailable) {
          const lxdResult = lxdUpdates.get(def.id);
          if (lxdResult?.hasUpdate && lxdResult.latestVersion) {
            updateAvailable = true;
            updateInfo = `${lxdResult.installedVersion || version || '?'} → ${lxdResult.latestVersion}`;
          }
          if (!version && lxdResult?.installedVersion) {
            version = lxdResult.installedVersion;
          }
        }

        // For native user apps, derive update status from the installed_apps DB.
        // Compute from versions (not the stored boolean) so it can't go stale.
        const dbEntry = dbAppsMap.get(def.id);
        if (dbEntry?.catalogVersion && dbEntry?.installedVersion && isNewer(dbEntry.catalogVersion, dbEntry.installedVersion)) {
          updateAvailable = true;
          updateInfo = `${dbEntry.installedVersion} → ${dbEntry.catalogVersion}`;
        }
        if (dbEntry?.installedVersion) {
          version = version ?? dbEntry.installedVersion;
        }

        const appStatus = def.containers.length > 0
          ? aggregateStatus(containers.map((c) => c.status))
          : 'running';

        return {
          id: def.id,
          displayName: def.displayName,
          description: def.description,
          icon: def.icon,
          category: def.category,
          type: def.type,
          containers,
          version,
          status: appStatus,
          enabled: true,
          desiredState: 'running' as const,
          updateAvailable,
          updateInfo,
        };
      })
      // Filter out user-category apps that are not installed (all containers not-found)
      .filter((app) => {
        if (app.category !== 'user') return true;
        return app.status !== 'not-installed';
      });

    // Add Market-installed apps (from install metadata), skipping any whose
    // containers are already covered by APP_DEFINITIONS (prevents duplicates
    // for native apps like Search/Wiki that also have install.json files).
    const definedContainers = new Set(
      apps.flatMap((a) => a.containers.map((c) => c.name))
    );

    const filteredMarket = installed
      .filter((meta) => {
        const names = meta.containers.map((c: any) =>
          typeof c === 'string' ? c : c.containerName
        );
        return !names.some((n: string) => definedContainers.has(n));
      });

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

    // Best-effort manifest lookup for icon/name/description
    const manifestResults = await Promise.allSettled(
      filteredMarket.map((meta) => fetchManifest(meta.appId))
    );

    const marketApps = filteredMarket.map((meta, i) => {
      const dbEntry = dbAppsMap.get(meta.appId);
      const catV = dbEntry?.catalogVersion;
      const insV = dbEntry?.installedVersion;
      const upd = !!(catV && insV && isNewer(catV, insV));
      const manifest = manifestResults[i].status === 'fulfilled'
        ? manifestResults[i].value
        : null;
      const containers = meta.containers.map((c: any) => {
        const name = typeof c === 'string' ? c : c.containerName;
        const state = containerStateMap.get(name);
        return { name, status: state?.status ?? 'not-found', ip: state?.ip };
      });
      const enabled = meta.enabled !== false && meta.desiredState !== 'stopped';
      return {
        id: meta.appId,
        displayName: manifest?.metadata.name || meta.appId,
        description: manifest?.metadata.description || 'Market app',
        icon: manifest?.metadata.icon || 'Package',
        iconUrl: manifest?.metadata.iconUrl || undefined,
        category: 'user' as const,
        type: 'docker-lxd',
        containers,
        version: dbEntry?.installedVersion ?? undefined,
        status: enabled ? aggregateStatus(containers.map((c) => c.status)) : 'stopped' as const,
        enabled,
        desiredState: enabled ? 'running' as const : 'stopped' as const,
        databaseMode: meta.databaseMode ?? 'none',
        updateAvailable: upd,
        updateInfo: upd && catV ? `${insV} → ${catV}` : undefined,
      };
    });

    return NextResponse.json({
      apps: [...apps, ...marketApps],
      lastCheckedAt: getLastCheckedAt(),
      checkInProgress: isCheckInProgress(),
    });
  } catch (err) {
    console.error('[UI Bridge] Apps error:', err);
    return NextResponse.json(
      { error: 'Failed to load apps' },
      { status: 500 }
    );
  }
}
