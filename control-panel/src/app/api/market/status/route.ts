/**
 * Unified App Market status API.
 * Returns install status of all apps (marketplace + native).
 *
 * GET /api/market/status         — all installed apps
 * GET /api/market/status?app=id  — single app
 */

import { NextRequest, NextResponse } from 'next/server';
import { listInstalledApps, readInstallMetadata } from '@/lib/market/metadata';
import { containerExists, getContainerIP } from '@/lib/infrastructure/oci-deployer';
import { incusRequest } from '@/lib/incus/server';
import { getInstalledApp } from '@/lib/market/installed-apps';
import type { AppStatusInfo, ContainerStatusInfo, AppStatus } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

// Known native app containers — check these even without install metadata
const NATIVE_CONTAINER_MAP: Record<string, string> = {
  wiki: 'ye-app-wiki',
  search: 'ye-app-search',
};

async function getContainerStatus(name: string): Promise<ContainerStatusInfo> {
  try {
    if (!(await containerExists(name))) {
      return { name, status: 'not-found' };
    }
    const resp = await incusRequest<Record<string, unknown>>(
      'GET',
      `/1.0/instances/${name}/state`
    );
    const meta = resp.metadata as Record<string, unknown> | undefined;
    const status = (meta?.status as string) || 'unknown';
    const ip = await getContainerIP(name);

    return {
      name,
      status: status === 'Running' ? 'running' : 'stopped',
      ip: ip ?? undefined,
    };
  } catch {
    return { name, status: 'not-found' };
  }
}

function deriveAppStatus(containers: ContainerStatusInfo[]): AppStatus {
  if (containers.length === 0) return 'not-installed';
  const allNotFound = containers.every((c) => c.status === 'not-found');
  if (allNotFound) return 'not-installed';
  const allRunning = containers.every((c) => c.status === 'running');
  if (allRunning) return 'running';
  const allStopped = containers.every((c) => c.status === 'stopped' || c.status === 'not-found');
  if (allStopped) return 'stopped';
  return 'partial';
}

async function getAppStatus(appId: string): Promise<AppStatusInfo> {
  const metadata = await readInstallMetadata(appId);

  if (metadata) {
    // Handle both v1 (string[]) and v2 (ContainerMeta[]) formats
    const containerNames = metadata.containers.map((c: any) => typeof c === 'string' ? c : c.containerName);
    const containers = await Promise.all(containerNames.map(getContainerStatus));
    const status = deriveAppStatus(containers);

    // Enrich with health + forward-auth data from DB
    let healthStatus: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
    let healthCheckedAt: string | null = null;
    let forwardAuthEnabled = false;
    try {
      const dbApp = await getInstalledApp(appId);
      if (dbApp) {
        healthStatus = dbApp.healthStatus;
        healthCheckedAt = dbApp.healthCheckedAt;
        forwardAuthEnabled = dbApp.forwardAuthEnabled;
      }
    } catch {}

    const baseUrl = metadata.subdomain && metadata.domain
      ? `https://${metadata.subdomain}.${metadata.domain}`
      : undefined;
    const entryUrl = metadata.ssoEntryUrl;

    return {
      appId,
      status,
      containers,
      subdomain: metadata.subdomain,
      domain: metadata.domain,
      url: baseUrl && entryUrl ? `${baseUrl}${entryUrl}` : baseUrl,
      installedAt: metadata.installedAt,
      healthStatus,
      healthCheckedAt,
      forwardAuthEnabled,
    };
  }

  // Check native container directly (for pre-migration installs)
  const nativeContainer = NATIVE_CONTAINER_MAP[appId];
  if (nativeContainer) {
    const containerStatus = await getContainerStatus(nativeContainer);
    if (containerStatus.status !== 'not-found') {
      return {
        appId,
        status: containerStatus.status === 'running' ? 'running' : 'stopped',
        containers: [containerStatus],
      };
    }
  }

  return { appId, status: 'not-installed', containers: [] };
}

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get('app');

  try {
    if (appId) {
      const status = await getAppStatus(appId);
      return NextResponse.json(status);
    }

    // Get all installed apps from metadata
    const installed = await listInstalledApps();
    const metadataStatuses = await Promise.all(installed.map((m) => getAppStatus(m.appId)));

    // Also check native apps that might not have metadata yet (pre-migration)
    const trackedIds = new Set(installed.map((m) => m.appId));
    const nativeStatuses: AppStatusInfo[] = [];
    for (const [appId, containerName] of Object.entries(NATIVE_CONTAINER_MAP)) {
      if (trackedIds.has(appId)) continue;
      const containerStatus = await getContainerStatus(containerName);
      if (containerStatus.status !== 'not-found') {
        nativeStatuses.push({
          appId,
          status: containerStatus.status === 'running' ? 'running' : 'stopped',
          containers: [containerStatus],
        });
      }
    }

    return NextResponse.json({ apps: [...metadataStatuses, ...nativeStatuses] });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
