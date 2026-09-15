import { getAllInstalledApps, updateHealthProbeState, updateHealthStatus } from './installed-apps';
import { readInstallMetadata } from './metadata';
import { containerExists, getContainerIP } from '@/lib/infrastructure/oci-deployer';
import { incusRequest, execShell } from '@/lib/incus/server';
import { observeIssue, resolveIssue, recordTimelineEvent } from '@/lib/health/issues';
import type { InstallMetadata } from './types';
import { isContainerMaintenanceActive } from '@/lib/maintenance/container-maintenance';
import { inspectAppStorage } from './storage';

export type AppHealthState = 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown';

export interface AppProbeResult {
  appId: string;
  state: AppHealthState;
  failingLevel?: 'L1' | 'L2' | 'L3';
  detail: string;
}

export interface ProbeState {
  failures: number;
  backoffMs: number;
  capCycles: number;
  lastRestartAt: number;
  healthySince: number | null;
}

const DEFAULT_PERIOD_MS = 30_000;
const DEFAULT_FAILURES = 3;
const BACKOFF_INITIAL_MS = 10_000;
const BACKOFF_CAP_MS = 300_000;
const HEALTHY_RESET_MS = 10 * 60_000;

const states = new Map<string, ProbeState>();
const results = new Map<string, AppProbeResult>();

export function shouldSuppressAppRecovery(meta: Pick<InstallMetadata, 'enabled' | 'desiredState' | 'lifecycleOperation'>): boolean {
  return meta.enabled === false || meta.desiredState === 'stopped'
    || (meta.lifecycleOperation?.desiredState === 'stopped' && meta.lifecycleOperation.state !== 'completed');
}

export function getAppProbeResults(): Record<string, AppProbeResult> {
  return Object.fromEntries(results);
}

export async function probeInstalledApps(): Promise<AppProbeResult[]> {
  const apps = await getAllInstalledApps();
  const output: AppProbeResult[] = [];
  for (const app of apps) {
    const result = await probeOne(app.appId, app.healthProbeState).catch(async (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[app-prober] ${app.appId} probe failed:`, err);
      await updateHealthStatus(app.appId, 'unknown', { appHealthState: 'unknown', healthDetail: detail });
      await observeIssue({
        id: `app.${app.appId}.health`,
        severity: 'error',
        source: 'app-prober',
        title: `${app.appId} could not be checked`,
        body: detail,
        fixable: false,
        debounce: 1,
      });
      return { appId: app.appId, state: 'unknown' as const, detail };
    });
    results.set(app.appId, result);
    output.push(result);
  }
  return output;
}

async function probeOne(appId: string, persistedState?: ProbeState): Promise<AppProbeResult> {
  const meta = await readInstallMetadata(appId);
  if (!meta) {
    await updateHealthStatus(appId, 'unknown', {
      appHealthState: 'unknown',
      healthDetail: 'install metadata missing',
    });
    return { appId, state: 'unknown', detail: 'install metadata missing' };
  }
  const metaAny = meta as any;

  if (shouldSuppressAppRecovery(meta)) {
    states.delete(appId);
    await updateHealthStatus(appId, 'unknown', {
      appHealthState: 'unknown',
      healthDetail: 'Intentionally stopped by administrator',
    });
    await resolveIssue(`app.${appId}.health`);
    return { appId, state: 'unknown', detail: 'Intentionally stopped by administrator' };
  }

  const storage = await inspectAppStorage(meta.storageVolumes);
  if (!storage.available) {
    states.delete(appId);
    await updateHealthStatus(appId, 'unhealthy', {
      appHealthState: 'unknown',
      healthDetail: storage.detail,
    });
    await observeIssue({
      id: `app.${appId}.storage`,
      severity: 'error',
      source: 'app-prober',
      title: `${appId} storage is disconnected`,
      body: `${storage.detail}. Reconnect the storage location before starting or repairing this app.`,
      fixable: false,
      debounce: 1,
    });
    await resolveIssue(`app.${appId}.health`);
    return { appId, state: 'unknown', detail: storage.detail };
  }
  await resolveIssue(`app.${appId}.storage`);

  const maintenanceContainers = (meta.containers ?? [])
    .map((container) => typeof container === 'string' ? container : container.containerName)
    .filter((name): name is string => Boolean(name));
  if (maintenanceContainers.some((name) => isContainerMaintenanceActive(name))) {
    states.delete(appId);
    await updateHealthStatus(appId, 'unknown', {
      appHealthState: 'starting',
      healthDetail: 'Update or rollback maintenance is in progress',
    });
    await resolveIssue(`app.${appId}.health`);
    return { appId, state: 'starting', detail: 'Update or rollback maintenance is in progress' };
  }

  const primary = primaryContainer(meta.containers, appId);
  const containerName = primary.containerName;
  const healthcheck = primary.healthCheck || metaAny.healthcheck || metaAny.healthCheck;
  if (!states.has(appId) && persistedState) states.set(appId, { ...persistedState });

  const l1 = await isRunning(containerName);
  if (!l1) {
    return await handleFailure(appId, containerName, 'L1', `${containerName} is not RUNNING`, meta, healthcheck);
  }

  const service = primary.service || primary.systemdService || metaAny.serviceName || inferServiceName(primary, containerName);
  if (service) {
    const active = await isServiceActive(containerName, service);
    if (!active) {
      return await handleFailure(appId, containerName, 'L2', `${service} is not active`, meta, healthcheck);
    }
  }

  const dependencyFailure = await checkDependencyFailure(meta.containers, containerName);
  if (dependencyFailure) {
    return await handleDependencyWait(appId, dependencyFailure.level, dependencyFailure.detail);
  }

  if (healthcheck !== false) {
    const l3 = await probeHTTP(containerName, healthcheck, primary.port);
    if (!l3.ok) {
      return await handleFailure(appId, containerName, 'L3', l3.detail, meta, healthcheck);
    }
  }

  const previous = states.get(appId);
  const nextState = {
    failures: 0,
    backoffMs: previous?.backoffMs ?? BACKOFF_INITIAL_MS,
    capCycles: previous?.capCycles ?? 0,
    lastRestartAt: previous?.lastRestartAt ?? 0,
    healthySince: previous?.healthySince ?? Date.now(),
  };
  states.set(appId, nextState);
  await updateHealthProbeState(appId, nextState);
  await updateHealthStatus(appId, 'healthy', {
    appHealthState: 'running',
    healthDetail: 'L1/L2/L3 healthy',
  });
  await resolveIssue(`app.${appId}.health`);
  return { appId, state: 'running', detail: 'L1/L2/L3 healthy' };
}

async function handleFailure(
  appId: string,
  containerName: string,
  failingLevel: 'L1' | 'L2' | 'L3',
  detail: string,
  meta: any,
  healthcheck: any,
): Promise<AppProbeResult> {
  const now = Date.now();
  const current = states.get(appId) ?? initialProbeState();
  const threshold = Number(healthcheck?.retries ?? DEFAULT_FAILURES);
  const autoRestart = meta.autoRestart !== false && healthcheck?.autoRestart !== false;
  const installedAt = Date.parse(meta.installedAt || '') || 0;
  const startReference = Math.max(installedAt, current.lastRestartAt);
  const decision = advanceProbeFailure(current, {
    threshold,
    autoRestart,
    startPeriodMs: Number(healthcheck?.startPeriod ?? 0),
  }, now, startReference);
  const state = decision.state;
  let resultState = decision.resultState;
  let restartError = '';

  states.set(appId, state);
  await updateHealthProbeState(appId, state);

  if (decision.inStartPeriod) {
    await updateHealthStatus(appId, 'unknown', { appHealthState: 'starting', failingLevel, healthDetail: `Starting: ${detail}` });
    return { appId, state: 'starting', failingLevel, detail: `Starting: ${detail}` };
  }

  if (decision.shouldRestart) {
    try {
      await restartWithDependencies(appId, containerName, meta);
      await recordTimelineEvent({
        id: `app.${appId}.restart.${now}`,
        source: 'app-prober',
        title: `${appId} restarted automatically`,
        body: `${failingLevel} failed: ${detail}. Next backoff is ${state.backoffMs / 1000}s.`,
      });
    } catch (error) {
      restartError = error instanceof Error ? error.message : String(error);
      resultState = 'unhealthy';
    }
  }

  await updateHealthStatus(
    appId,
    resultState === 'crash-looping' || resultState === 'unhealthy' ? 'unhealthy' : 'unknown',
    {
      appHealthState: resultState,
      failingLevel,
      healthDetail: detail,
    },
  );
  if (resultState === 'unhealthy' || resultState === 'crash-looping') {
    const excerpt = resultState === 'crash-looping' ? await logExcerpt(containerName) : '';
    await observeIssue({
      id: `app.${appId}.health`,
      severity: resultState === 'crash-looping' || restartError ? 'error' : 'warning',
      source: 'app-prober',
      title: resultState === 'crash-looping'
        ? `${appId} stopped restarting after repeated failures`
        : `${appId} health check failed`,
      body: restartError
        ? `${detail}. Automatic recovery failed: ${restartError}`
        : `${failingLevel}: ${detail}${excerpt ? ` Recent logs: ${excerpt}` : ''}`,
      fixable: false,
      debounce: 1,
    });
  }
  return { appId, state: resultState, failingLevel, detail };
}

async function handleDependencyWait(
  appId: string,
  failingLevel: 'L1' | 'L2',
  detail: string,
): Promise<AppProbeResult> {
  await updateHealthStatus(appId, 'unknown', {
    appHealthState: 'starting',
    failingLevel,
    healthDetail: detail,
  });
  await resolveIssue(`app.${appId}.health`);
  return { appId, state: 'starting', failingLevel, detail };
}

async function restartWithDependencies(appId: string, containerName: string, meta: any): Promise<void> {
  const deps = dependencyOrder(meta.containers);
  for (const dep of deps) {
    if (dep === containerName) continue;
    if (await containerExists(dep)) {
      await incusRequest('PUT', `/1.0/instances/${dep}/state`, { action: 'start', timeout: 30 });
    }
  }
  await incusRequest('PUT', `/1.0/instances/${containerName}/state`, { action: 'restart', timeout: 30 }).catch(async () => {
    await incusRequest('PUT', `/1.0/instances/${containerName}/state`, { action: 'start', timeout: 30 });
  });
}

async function checkDependencyFailure(
  containers: any[] | undefined,
  primaryContainerName: string,
): Promise<{ level: 'L1' | 'L2'; detail: string } | null> {
  for (const dependency of dependencyContainers(containers, primaryContainerName)) {
    if (!(await isRunning(dependency.containerName))) {
      return {
        level: 'L1',
        detail: `waiting on ${dependency.name}: ${dependency.containerName} is not RUNNING`,
      };
    }

    const service = dependency.service
      || dependency.systemdService
      || inferServiceName(dependency, dependency.containerName);
    if (service) {
      const active = await isServiceActive(dependency.containerName, service);
      if (!active) {
        return {
          level: 'L2',
          detail: `waiting on ${dependency.name}: ${service} is not active`,
        };
      }
    }
  }

  return null;
}

async function isRunning(name: string): Promise<boolean> {
  if (!(await containerExists(name))) return false;
  const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${name}/state`);
  const meta = resp.metadata as Record<string, unknown> | undefined;
  return meta?.status === 'Running';
}

async function isServiceActive(containerName: string, service: string): Promise<boolean> {
  const res = await execShell(containerName, `systemctl is-active ${shellQuote(service)}`, { timeout: 10_000 });
  return res.exitCode === 0 && res.stdout.trim() === 'active';
}

async function probeHTTP(containerName: string, healthcheck: any, fallbackPort?: number): Promise<{ ok: boolean; detail: string }> {
  const ip = await getContainerIP(containerName);
  if (!ip) return { ok: false, detail: 'container has no IP address' };
  const port = Number(healthcheck?.port ?? fallbackPort ?? 3000);
  const path = String(healthcheck?.path ?? '/');
  const timeoutMs = Number(healthcheck?.timeoutMs ?? healthcheck?.timeout ?? 5000);
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok || res.status === 401 || res.status === 403) return { ok: true, detail: `HTTP ${res.status}` };
    return { ok: false, detail: `HTTP ${res.status} from ${path}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function logExcerpt(containerName: string): Promise<string> {
  try {
    const res = await execShell(containerName, 'journalctl -n 20 --no-pager 2>/dev/null | tail -20', { timeout: 10_000 });
    return res.stdout.trim().slice(-1200);
  } catch (error) {
    return `Log excerpt unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function primaryContainer(containers: any[] | undefined, appId: string): any {
  if (!containers || containers.length === 0) return { containerName: `app-${appId}`, port: 3000 };
  const primary = containers.find((c) => typeof c !== 'string' && c.primary) ?? containers[0];
  if (typeof primary === 'string') return { containerName: primary, port: 3000 };
  return { ...primary, containerName: primary.containerName || primary.name || `app-${appId}` };
}

function inferServiceName(primary: any, containerName: string): string | undefined {
  if (primary?.type !== 'lxd' && primary?.type !== 'native') return undefined;
  return `${containerName}.service`;
}

function dependencyOrder(containers: any[] | undefined): string[] {
  if (!containers) return [];
  return containers
    .map((c) => typeof c === 'string' ? { containerName: c, dependsOn: [] } : c)
    .sort((a, b) => Number(Boolean(a.dependsOn?.length)) - Number(Boolean(b.dependsOn?.length)))
    .map((c) => c.containerName || c.name)
    .filter(Boolean);
}

function dependencyContainers(containers: any[] | undefined, primaryContainerName: string): any[] {
  if (!containers) return [];
  return containers
    .map((container) => typeof container === 'string'
      ? { name: container, containerName: container }
      : { ...container, name: container.name || container.containerName, containerName: container.containerName || container.name })
    .filter((container) => container.containerName && container.containerName !== primaryContainerName);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function resetHealthyBackoff(): Promise<void> {
  const now = Date.now();
  for (const [appId, state] of states) {
    const reset = resetProbeBackoff(state, now);
    if (reset !== state) {
      states.set(appId, reset);
      await updateHealthProbeState(appId, reset);
    }
  }
}

export interface ProbePolicy {
  threshold: number;
  autoRestart: boolean;
  startPeriodMs: number;
}

export interface ProbeDecision {
  state: ProbeState;
  resultState: AppHealthState;
  shouldRestart: boolean;
  inStartPeriod: boolean;
}

export function initialProbeState(): ProbeState {
  return { failures: 0, backoffMs: BACKOFF_INITIAL_MS, capCycles: 0, lastRestartAt: 0, healthySince: null };
}

export function advanceProbeFailure(
  current: ProbeState,
  policy: ProbePolicy,
  now: number,
  startReference: number,
): ProbeDecision {
  const state = { ...current };
  if (policy.startPeriodMs > 0 && startReference > 0 && now - startReference < policy.startPeriodMs) {
    state.failures = 0;
    state.healthySince = null;
    return { state, resultState: 'starting', shouldRestart: false, inStartPeriod: true };
  }

  state.failures += 1;
  state.healthySince = null;
  const threshold = Math.max(1, Number.isFinite(policy.threshold) ? policy.threshold : DEFAULT_FAILURES);
  let resultState: AppHealthState = state.failures >= threshold ? 'unhealthy' : 'starting';
  let shouldRestart = false;

  if (state.failures >= threshold && policy.autoRestart && now - state.lastRestartAt >= state.backoffMs) {
    if (state.backoffMs >= BACKOFF_CAP_MS) state.capCycles += 1;
    if (state.capCycles >= 2) {
      resultState = 'crash-looping';
    } else {
      state.lastRestartAt = now;
      state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_CAP_MS);
      resultState = 'starting';
      shouldRestart = true;
    }
  }

  return { state, resultState, shouldRestart, inStartPeriod: false };
}

export function resetProbeBackoff(state: ProbeState, now: number): ProbeState {
  if (!state.healthySince || now - state.healthySince < HEALTHY_RESET_MS) return state;
  return { failures: 0, backoffMs: BACKOFF_INITIAL_MS, capCycles: 0, lastRestartAt: 0, healthySince: now };
}

export const APP_PROBER_DEFAULT_PERIOD_MS = DEFAULT_PERIOD_MS;
