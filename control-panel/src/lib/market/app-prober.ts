import { getAllInstalledApps, updateHealthProbeState, updateHealthStatus } from './installed-apps';
import { readInstallMetadata } from './metadata';
import { getContainerIP } from '@/lib/infrastructure/oci-deployer';
import { incusRequest, execShell } from '@/lib/incus/server';
import { observeIssue, resolveIssue } from '@/lib/health/issues';
import type { InstallMetadata } from './types';
import { isContainerMaintenanceActive } from '@/lib/maintenance/container-maintenance';
import { inspectAppStorage } from './storage';
import { isAppHeld, isAppHeldByCaller, isAppUpdateReserved } from './update-admission';
import { appReconciler, shouldSuppressAppRecovery } from '@/lib/apps/app-reconciler';

export { shouldSuppressAppRecovery };

export type AppHealthState = 'starting' | 'running' | 'unhealthy' | 'crash-looping' | 'unknown' | 'maintenance';

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

export function getAppProbeResults(): Record<string, AppProbeResult> {
  return Object.fromEntries(results);
}

export async function probeInstalledApps(): Promise<AppProbeResult[]> {
  const apps = await getAllInstalledApps();
  const output: AppProbeResult[] = [];
  for (const app of apps) {
    const result = await probeInstalledApp(app.appId, app.healthProbeState).catch(async (err) => {
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

/**
 * A probe only reads, and never takes the app's lifecycle lock (a probe that held it starved the watchdog).
 * It reads intent first: an app under an update is in maintenance, an app an operation holds is busy, and
 * neither counts as a failure. A restart it decides on goes to the app's reconcile queue.
 */
export async function probeInstalledApp(appId: string, persistedState?: ProbeState): Promise<AppProbeResult> {
  // The check also applies to verification calls inside an updater.
  if (isAppUpdateReserved(appId)) return await publishAppMaintenance(appId);
  const meta = await readInstallMetadata(appId);
  if (meta && shouldSuppressAppRecovery(meta)) return await publishIntentionallyStopped(appId);
  if (heldByAnother(appId)) return busy(appId);
  return await probeOne(appId, meta, persistedState);
}

/** An operation (a backup, an install step, a start) holds the app: not maintenance, and not a new state. */
function busy(appId: string): AppProbeResult {
  return { appId, state: 'unknown', detail: 'Busy with another operation on this app' };
}

/** An operation may probe the app it holds (a restore checks what it restored); every other holder means busy. */
function heldByAnother(appId: string): boolean {
  return isAppHeld(appId) && !isAppHeldByCaller(appId);
}

/** The app was taken while its probe ran: what the probe saw says nothing about its health. */
function takenMeanwhile(appId: string, containers: string[]): boolean {
  return heldByAnother(appId) || isAppUpdateReserved(appId) || containers.some(name => isContainerMaintenanceActive(name));
}

async function publishIntentionallyStopped(appId: string): Promise<AppProbeResult> {
  const detail = 'Intentionally stopped by administrator';
  states.delete(appId);
  await updateHealthStatus(appId, 'unknown', { appHealthState: 'unknown', healthDetail: detail });
  await resolveIssue(`app.${appId}.health`);
  return { appId, state: 'unknown', detail };
}

async function publishAppMaintenance(appId: string): Promise<AppProbeResult> {
  const detail = 'Update maintenance or explicit recovery is pending';
  states.delete(appId);
  await updateHealthStatus(appId, 'unknown', { appHealthState: 'maintenance', healthDetail: detail });
  return { appId, state: 'maintenance', detail };
}

async function probeOne(appId: string, meta: InstallMetadata | null, persistedState?: ProbeState): Promise<AppProbeResult> {
  if (!meta) {
    await updateHealthStatus(appId, 'unknown', {
      appHealthState: 'unknown',
      healthDetail: 'install metadata missing',
    });
    return { appId, state: 'unknown', detail: 'install metadata missing' };
  }
  const metaAny = meta as any;

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

  if (containerNames(meta).some((name) => isContainerMaintenanceActive(name))) {
    states.delete(appId);
    return publishAppMaintenance(appId);
  }

  const primary = primaryContainer(meta.containers, appId);
  const containerName = primary.containerName;
  const healthcheck = primary.healthCheck || metaAny.healthcheck || metaAny.healthCheck;
  if (!states.has(appId) && persistedState) states.set(appId, { ...persistedState });

  const l1 = await isRunning(containerName);
  if (!l1) {
    return await handleFailure(appId, containerName, 'L1', `${containerName} is not RUNNING`, meta, healthcheck);
  }

  // A passing HTTP check proves the service runs, so the service is asked (an exec into the container) only when the
  // app has no HTTP check or the check fails. The outcome order is unchanged: L2, then a dependency, then L3.
  const l3 = healthcheck !== false ? await probeHTTP(containerName, healthcheck, primary.port) : null;
  const service = primary.service || primary.systemdService || metaAny.serviceName || inferServiceName(primary, containerName);
  if (service && !l3?.ok) {
    const active = await isServiceActive(containerName, service);
    if (!active) {
      return await handleFailure(appId, containerName, 'L2', `${service} is not active`, meta, healthcheck);
    }
  }

  const dependencyFailure = await checkDependencyFailure(meta.containers, containerName);
  if (dependencyFailure) {
    return await handleDependencyWait(appId, dependencyFailure.level, dependencyFailure.detail);
  }

  if (l3 && !l3.ok) {
    return await handleFailure(appId, containerName, 'L3', l3.detail, meta, healthcheck);
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
  // A crash-loop record left by a prober restart clears on this, not on the container merely running.
  appReconciler().observeHealthy(appId);
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
  if (takenMeanwhile(appId, containerNames(meta))) return busy(appId);
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
  const resultState = decision.resultState;

  states.set(appId, state);
  await updateHealthProbeState(appId, state);

  if (decision.inStartPeriod) {
    await updateHealthStatus(appId, 'unknown', { appHealthState: 'starting', failingLevel, healthDetail: `Starting: ${detail}` });
    return { appId, state: 'starting', failingLevel, detail: `Starting: ${detail}` };
  }

  if (decision.shouldRestart) {
    appReconciler().request(appId, 'restart',
      `${failingLevel} failed: ${detail}. Next backoff is ${state.backoffMs / 1000}s.`);
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
      severity: resultState === 'crash-looping' ? 'error' : 'warning',
      source: 'app-prober',
      title: resultState === 'crash-looping'
        ? `${appId} stopped restarting after repeated failures`
        : `${appId} health check failed`,
      body: `${failingLevel}: ${detail}${excerpt ? ` Recent logs: ${excerpt}` : ''}`,
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

/**
 * The instance record carries the status. `/state` would also make Incus measure disk usage (a `zfs get` per call),
 * which the prober never reads. A missing instance or an unreachable Incus reads as not running, as before.
 */
async function isRunning(name: string): Promise<boolean> {
  try {
    const resp = await incusRequest<{ status?: unknown }>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
    if (resp.type === 'error') return false;
    return resp.metadata?.status === 'Running';
  } catch {
    return false;
  }
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
    // Only the status counts: let the body go, or the idle connection ends later under a paused body and Node's HTTP
    // client throws an uncaught assertion (`assert(!this.paused)`), as waitForAppHealth did (YE-213).
    await res.body?.cancel().catch(() => undefined);
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
  const primary = containers.find((c) => c.primary) ?? containers[0];
  return { ...primary, containerName: primary.containerName || primary.name || `app-${appId}` };
}

function inferServiceName(primary: any, containerName: string): string | undefined {
  if (primary?.type !== 'lxd' && primary?.type !== 'native') return undefined;
  return `${containerName}.service`;
}

function containerNames(meta: Pick<InstallMetadata, 'containers'>): string[] {
  return (meta.containers ?? []).map((container) => container.containerName).filter(Boolean);
}

function dependencyContainers(containers: any[] | undefined, primaryContainerName: string): any[] {
  if (!containers) return [];
  return containers
    .map((container) => ({ ...container, name: container.name || container.containerName, containerName: container.containerName || container.name }))
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
