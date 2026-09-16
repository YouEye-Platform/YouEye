import { incusRequest } from '@/lib/incus/server';
import { listInstalledApps, readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import type { ContainerMeta, InstallMetadata } from '@/lib/market/types';
import { setPointerManagedAppEnabled } from '@/lib/pointer/managed-apps';
import { pushAppRuntimeStatusToUI } from '@/lib/ui/app-status';
import { randomUUID } from 'crypto';

export type AppPowerAction = 'start' | 'stop' | 'restart' | 'status';
export type AppRuntimeStatus = 'running' | 'stopped' | 'partial' | 'not-installed' | 'unknown';

export interface AppLifecycleResult {
  success: boolean;
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
    error?: string;
  }>;
  intentPersisted: boolean;
  operationState: 'applying' | 'completed' | 'partial';
  observationErrors: string[];
  repairRequired: boolean;
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
  if (statuses.some((s) => s === 'unknown')) return running > 0 ? 'partial' : 'unknown';
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
  const statuses: Array<ContainerTarget & { status: string; error?: string }> = await Promise.all(
    containers.map(async (container) => {
      try {
        return { ...container, status: await getContainerStatus(container.name) };
      } catch (error) {
        return {
          ...container,
          status: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
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

  const observationErrors = statuses
    .filter((container) => container.error)
    .map((container) => `${container.name}: ${container.error}`);
  const operationState = meta.lifecycleOperation?.state ?? 'completed';

  return {
    success: operationState === 'completed' && observationErrors.length === 0,
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
      error: container.error,
    })),
    intentPersisted: true,
    operationState,
    observationErrors,
    repairRequired: operationState === 'partial' || observationErrors.length > 0,
    uiStatusSynced,
    message: actionMessage[action],
  };
}

function desiredStateFor(action: Exclude<AppPowerAction, 'status'>): 'running' | 'stopped' {
  return action === 'stop' ? 'stopped' : 'running';
}

async function beginLifecycleOperation(
  meta: InstallMetadata,
  action: Exclude<AppPowerAction, 'status'>,
  actor: string,
  containers: ContainerTarget[],
): Promise<void> {
  const now = new Date().toISOString();
  const desiredState = desiredStateFor(action);
  meta.enabled = desiredState === 'running';
  meta.desiredState = desiredState;
  meta.lastPowerAction = action;
  if (desiredState === 'stopped') {
    meta.disabledAt = now;
    meta.disabledBy = actor;
  } else {
    delete meta.disabledAt;
    delete meta.disabledBy;
  }
  meta.lifecycleOperation = {
    id: randomUUID(),
    action,
    desiredState,
    state: 'applying',
    actor,
    startedAt: now,
    updatedAt: now,
    containers: containers.map((container) => ({
      name: container.name,
      bootAutostart: 'pending',
      runtime: 'pending',
    })),
  };
  await saveInstallMetadata(meta);
}

async function updateLifecycleProgress(
  meta: InstallMetadata,
  containerName: string,
  field: 'bootAutostart' | 'runtime',
): Promise<void> {
  const progress = meta.lifecycleOperation?.containers.find((entry) => entry.name === containerName);
  if (progress) progress[field] = 'applied';
  if (meta.lifecycleOperation) meta.lifecycleOperation.updatedAt = new Date().toISOString();
  await saveInstallMetadata(meta);
}

async function finishLifecycleOperation(meta: InstallMetadata, error?: unknown): Promise<void> {
  if (!meta.lifecycleOperation) return;
  meta.lifecycleOperation.state = error ? 'partial' : 'completed';
  meta.lifecycleOperation.updatedAt = new Date().toISOString();
  if (error) meta.lifecycleOperation.error = error instanceof Error ? error.message : String(error);
  else delete meta.lifecycleOperation.error;
  await saveInstallMetadata(meta);
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
  if (action === 'stop') {
    const ordered = orderContainers(containers, 'stop');
    if (meta.aiConnection) {
      await setPointerManagedAppEnabled(meta.aiConnection.externalInstallationId, false);
      meta.aiConnection.state = 'disabled';
    }
    await beginLifecycleOperation(meta, action, actor, ordered);
    try {
      for (const container of ordered) {
        await setBootAutostart(container.name, false);
        await updateLifecycleProgress(meta, container.name, 'bootAutostart');
      }
      for (const container of ordered) {
        await changeContainerState(container.name, 'stop', true);
        await updateLifecycleProgress(meta, container.name, 'runtime');
      }
      await finishLifecycleOperation(meta);
    } catch (error) {
      await finishLifecycleOperation(meta, error);
    }

    uiStatusSynced = await pushAppRuntimeStatusToUI(meta.appId, 'stopped');
    return buildResult(meta, action, containers, uiStatusSynced);
  }

  if (action === 'start') {
    const ordered = orderContainers(containers, 'start');
    let aiEnabledForStart = false;
    if (meta.aiConnection) {
      await setPointerManagedAppEnabled(meta.aiConnection.externalInstallationId, true);
      meta.aiConnection.state = 'active';
      aiEnabledForStart = true;
    }
    await beginLifecycleOperation(meta, action, actor, ordered);
    try {
      for (const container of ordered) {
        await setBootAutostart(container.name, true);
        await updateLifecycleProgress(meta, container.name, 'bootAutostart');
      }
      for (const container of ordered) {
        await changeContainerState(container.name, 'start', options.force === true);
        await updateLifecycleProgress(meta, container.name, 'runtime');
      }
      await finishLifecycleOperation(meta);
    } catch (error) {
      if (aiEnabledForStart && meta.aiConnection) {
        await setPointerManagedAppEnabled(
          meta.aiConnection.externalInstallationId,
          false
        ).catch(() => undefined);
        meta.aiConnection.state = 'disabled';
      }
      await finishLifecycleOperation(meta, error);
    }

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
    await beginLifecycleOperation(meta, action, actor, startOrder);
    try {
      for (const container of startOrder) {
        await setBootAutostart(container.name, true);
        await updateLifecycleProgress(meta, container.name, 'bootAutostart');
      }
      for (const container of stopOrder) await changeContainerState(container.name, 'stop', true);
      for (const container of startOrder) {
        await changeContainerState(container.name, 'start', true);
        await updateLifecycleProgress(meta, container.name, 'runtime');
      }
      await finishLifecycleOperation(meta);
    } catch (error) {
      await finishLifecycleOperation(meta, error);
    }

    const result = await buildResult(meta, action, containers);
    uiStatusSynced = await pushAppRuntimeStatusToUI(meta.appId, result.status === 'running' ? 'healthy' : 'unhealthy');
    return { ...result, uiStatusSynced };
  }

  throw new Error(`Unsupported app power action: ${String(action)}`);
}
