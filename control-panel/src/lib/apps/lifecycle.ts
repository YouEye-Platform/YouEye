import { incusRequest } from '@/lib/incus/server';
import { listInstalledApps, readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import type { ContainerMeta, InstallMetadata } from '@/lib/market/types';
import { pushAppRuntimeStatusToUI } from '@/lib/ui/app-status';

export type AppPowerAction = 'start' | 'stop' | 'restart' | 'status';
export type AppRuntimeStatus = 'running' | 'stopped' | 'partial' | 'not-installed' | 'unknown';

export interface AppLifecycleResult {
  success: true;
  appId: string;
  action: AppPowerAction;
  enabled: boolean;
  desiredState: 'running' | 'stopped';
  status: AppRuntimeStatus;
  databaseMode: InstallMetadata['databaseMode'];
  containers: Array<{
    name: string;
    status: string;
    role: ContainerMeta['role'];
    primary: boolean;
  }>;
  uiStatusSynced?: boolean;
  message: string;
}

interface ContainerTarget {
  name: string;
  role: NonNullable<ContainerMeta['role']>;
  primary: boolean;
  order: number;
}

function isIncusError(resp: { type?: string; error?: string; error_code?: number; status_code?: number }): boolean {
  return resp.type === 'error' || !!resp.error || (typeof resp.error_code === 'number' && resp.error_code > 0);
}

function assertIncusOK(resp: { type?: string; error?: string; error_code?: number; status_code?: number }, context: string): void {
  if (isIncusError(resp)) {
    throw new Error(`${context}: ${resp.error || `Incus error ${resp.error_code ?? resp.status_code ?? 'unknown'}`}`);
  }
}

async function waitForOperation(operation: string, timeoutSeconds = 90): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'GET',
    `${operation}/wait?timeout=${timeoutSeconds}`,
    undefined,
    { timeout: (timeoutSeconds + 30) * 1000 },
  );
  assertIncusOK(resp, 'Incus operation wait failed');
  const meta = resp.metadata as Record<string, unknown> | undefined;
  if (meta?.status === 'Failure') {
    throw new Error(`Incus operation failed: ${String(meta.err || 'unknown error')}`);
  }
}

async function getContainerStatus(name: string): Promise<string> {
  const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${encodeURIComponent(name)}/state`);
  if (resp.status_code === 404 || resp.error_code === 404) return 'not-found';
  assertIncusOK(resp, `Failed to read ${name} state`);
  const meta = resp.metadata ?? {};
  return ((meta.status as string) ?? 'unknown').toLowerCase();
}

async function setBootAutostart(name: string, enabled: boolean): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PATCH',
    `/1.0/instances/${encodeURIComponent(name)}`,
    { config: { 'boot.autostart': enabled ? 'true' : 'false' } },
  );
  if (resp.status_code === 404 || resp.error_code === 404) {
    throw new Error(`Container ${name} does not exist`);
  }
  assertIncusOK(resp, `Failed to set ${name} boot.autostart`);
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation);
}

async function changeContainerState(
  name: string,
  action: 'start' | 'stop' | 'restart',
  force = false,
): Promise<void> {
  const status = await getContainerStatus(name);
  if (status === 'not-found') throw new Error(`Container ${name} does not exist`);
  if (action === 'start' && status === 'running') return;
  if (action === 'stop' && status === 'stopped') return;
  if (action === 'restart' && status !== 'running') {
    throw new Error(`Container ${name} must be running before restart`);
  }

  const resp = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${encodeURIComponent(name)}/state`,
    { action, force, timeout: 45 },
    { timeout: 90_000 },
  );
  assertIncusOK(resp, `Failed to ${action} ${name}`);
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation);
}

function inferRole(container: ContainerMeta, primary: boolean): NonNullable<ContainerMeta['role']> {
  if (container.role) return container.role;
  const name = `${container.name} ${container.containerName}`.toLowerCase();
  if (/(postgres|postgresql|mysql|mariadb|mongo|database|\bdb\b)/.test(name)) return 'database';
  if (/(redis|memcached|cache)/.test(name)) return 'cache';
  if (/(worker|queue|cron|scheduler|job)/.test(name)) return 'worker';
  if (primary) return 'app';
  return 'sidecar';
}

function normalizeContainers(meta: InstallMetadata): ContainerTarget[] {
  const raw = meta.containers ?? [];
  const primaryIndex = raw.findIndex((c) => typeof c !== 'string' && c.primary);

  return raw
    .map((entry, index) => {
      if (typeof entry === 'string') {
        const primary = primaryIndex === -1 && index === 0;
        return {
          name: entry,
          role: primary ? 'app' as const : 'sidecar' as const,
          primary,
          order: index,
        };
      }

      const primary = entry.primary === true || (primaryIndex === -1 && index === 0);
      return {
        name: entry.containerName,
        role: inferRole(entry, primary),
        primary,
        order: index,
      };
    })
    .filter((container) => !!container.name);
}

function orderContainers(containers: ContainerTarget[], action: 'start' | 'stop'): ContainerTarget[] {
  const startRank: Record<ContainerTarget['role'], number> = {
    database: 0,
    cache: 1,
    sidecar: 2,
    worker: 3,
    app: 4,
  };
  const stopRank: Record<ContainerTarget['role'], number> = {
    app: 0,
    worker: 1,
    sidecar: 2,
    cache: 3,
    database: 4,
  };
  const ranks = action === 'start' ? startRank : stopRank;
  return [...containers].sort((a, b) => {
    const byRole = ranks[a.role] - ranks[b.role];
    if (byRole !== 0) return byRole;
    return action === 'start' ? a.order - b.order : b.order - a.order;
  });
}

function aggregateStatus(statuses: string[]): AppRuntimeStatus {
  if (statuses.length === 0) return 'unknown';
  const running = statuses.filter((s) => s === 'running').length;
  if (running === statuses.length) return 'running';
  if (running === 0) {
    if (statuses.every((s) => s === 'not-found')) return 'not-installed';
    return 'stopped';
  }
  return 'partial';
}

async function resolveInstalledApp(appId: string): Promise<InstallMetadata | null> {
  const direct = await readInstallMetadata(appId);
  if (direct) return direct;

  const normalized = appId.toLowerCase();
  const installed = await listInstalledApps();
  return installed.find((meta) => meta.appId.toLowerCase() === normalized) ?? null;
}

async function buildResult(
  meta: InstallMetadata,
  action: AppPowerAction,
  containers: ContainerTarget[],
  uiStatusSynced?: boolean,
): Promise<AppLifecycleResult> {
  const statuses = await Promise.all(containers.map(async (container) => ({
    ...container,
    status: await getContainerStatus(container.name),
  })));
  const status = aggregateStatus(statuses.map((container) => container.status));
  const enabled = meta.enabled !== false && meta.desiredState !== 'stopped';
  const desiredState: 'running' | 'stopped' = enabled ? 'running' : 'stopped';
  const label = meta.appId;
  const actionMessage: Record<AppPowerAction, string> = {
    start: `${label} started`,
    stop: `${label} turned off`,
    restart: `${label} restarted`,
    status: `${label} is ${status}`,
  };

  return {
    success: true,
    appId: meta.appId,
    action,
    enabled,
    desiredState,
    status,
    databaseMode: meta.databaseMode ?? 'none',
    containers: statuses.map((container) => ({
      name: container.name,
      status: container.status,
      role: container.role,
      primary: container.primary,
    })),
    uiStatusSynced,
    message: actionMessage[action],
  };
}

export async function controlInstalledApp(
  appId: string,
  action: AppPowerAction,
  actor: string,
  options: { force?: boolean } = {},
): Promise<AppLifecycleResult> {
  const meta = await resolveInstalledApp(appId);
  if (!meta) {
    throw new Error(`Unknown installed app: ${appId}`);
  }

  const containers = normalizeContainers(meta);
  if (containers.length === 0) {
    throw new Error(`App ${meta.appId} has no controllable containers`);
  }

  if (action === 'status') {
    return buildResult(meta, action, containers);
  }

  let uiStatusSynced: boolean | undefined;
  const now = new Date().toISOString();

  if (action === 'stop') {
    const ordered = orderContainers(containers, 'stop');
    for (const container of ordered) await setBootAutostart(container.name, false);
    for (const container of ordered) await changeContainerState(container.name, 'stop', true);

    meta.enabled = false;
    meta.desiredState = 'stopped';
    meta.disabledAt = now;
    meta.disabledBy = actor;
    meta.lastPowerAction = 'stop';
    await saveInstallMetadata(meta);

    uiStatusSynced = await pushAppRuntimeStatusToUI(meta.appId, 'stopped');
    return buildResult(meta, action, containers, uiStatusSynced);
  }

  if (action === 'start') {
    const ordered = orderContainers(containers, 'start');
    for (const container of ordered) await setBootAutostart(container.name, true);
    for (const container of ordered) await changeContainerState(container.name, 'start', options.force === true);

    meta.enabled = true;
    meta.desiredState = 'running';
    delete meta.disabledAt;
    delete meta.disabledBy;
    meta.lastPowerAction = 'start';
    await saveInstallMetadata(meta);

    const result = await buildResult(meta, action, containers);
    uiStatusSynced = await pushAppRuntimeStatusToUI(meta.appId, result.status === 'running' ? 'healthy' : 'unhealthy');
    return { ...result, uiStatusSynced };
  }

  if (action === 'restart') {
    if ((meta.enabled === false || meta.desiredState === 'stopped') && options.force !== true) {
      throw new Error(`App ${meta.appId} is turned off. Start it before restarting.`);
    }

    const stopOrder = orderContainers(containers, 'stop');
    const startOrder = orderContainers(containers, 'start');
    for (const container of startOrder) await setBootAutostart(container.name, true);
    for (const container of stopOrder) await changeContainerState(container.name, 'stop', true);
    for (const container of startOrder) await changeContainerState(container.name, 'start', true);

    meta.enabled = true;
    meta.desiredState = 'running';
    delete meta.disabledAt;
    delete meta.disabledBy;
    meta.lastPowerAction = 'restart';
    await saveInstallMetadata(meta);

    const result = await buildResult(meta, action, containers);
    uiStatusSynced = await pushAppRuntimeStatusToUI(meta.appId, result.status === 'running' ? 'healthy' : 'unhealthy');
    return { ...result, uiStatusSynced };
  }

  throw new Error(`Unsupported app power action: ${String(action)}`);
}
