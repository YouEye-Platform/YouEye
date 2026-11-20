/**
 * Automatic recovery of app containers: one queue per app.
 *
 * The prober (a restart verdict), the watchdog (a container that should run is Stopped) and the end of every
 * lifecycle operation only ask. The worker here is the only one that acts: it takes the app's lifecycle lock,
 * re-checks every condition under it, and retries a busy app within seconds instead of waiting for a next tick.
 * An operation that takes the app cancels what is pending; its end asks again. Users go first, for two minutes.
 */
import type { AppOperationOrigin } from '../market/update-admission';
import {
  isAppHeld, isAppUpdateReserved, isUserOperationWaiting, outsideOperation, setAppOperationListener,
  withAppLifecycle, withContainerLifecycle,
} from '../market/update-admission';
import { isContainerMaintenanceActive } from '../maintenance/container-maintenance';
import { listInstalledApps, readInstallMetadata } from '../market/metadata';
import { inspectAppStorage } from '../market/storage';
import { incusRequest } from '../incus/server';
import { waitForIncusOperation } from '../infrastructure/oci-deployer';
import type { InstallMetadata } from '../market/types';
import { containerRole, containerTargets, orderContainers, type ContainerTarget } from './container-order';
import { readinessCheck } from './container-readiness';
import { containerState, restartContainer, stopTimeoutSec } from '../incus/snapshot';

/** Clean-stop window of an automatic restart: below the 30 s a user waits for the app's lock. */
export const AUTOMATIC_RESTART_STOP_SEC = 20;

export type ReconcileKind = 'start' | 'restart';

const RETRY_MIN_MS = 2_000;
const RETRY_SPREAD_MS = 3_000;
/** An automatic request waits this long behind waiting users, then takes its turn. */
export const USERS_FIRST_MS = 2 * 60_000;
export const CRASH_LOOP_STARTS = 3;
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;
/** Running this long after the last automatic start clears the crash-loop record. */
export const CRASH_LOOP_CLEAR_MS = 10 * 60_000;

export type ReconcileEvent =
  | { type: 'started'; appId: string; container: string; reason: string }
  | { type: 'restarted'; appId: string; reason: string }
  | { type: 'retry'; appId: string; cause: 'busy' | 'user'; delayMs: number }
  | { type: 'failed'; appId: string; error: unknown }
  | { type: 'crash-loop'; appId: string; container: string; starts: number }
  | { type: 'crash-loop-cleared'; container: string };

export interface RestartOptions {
  /** The container's automatic starts are paused by a crash loop. */
  paused(name: string): boolean;
  /** A user waits for the app: stop before the next step and give the lock back. */
  yieldNow(): boolean;
}

export interface RestartResult {
  /** Stopped dependencies that were started, in order. */
  started: string[];
  /** The main container, when it was restarted (or started, when it was not running). */
  restarted?: string;
  /** Stopped for a waiting user: the restart is asked again. */
  yielded?: boolean;
  /** What stopped the restart after `started` was started: the queue counts those starts, then throws this. */
  failure?: unknown;
}

export interface ReconcilerDeps {
  now(): number;
  random(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  /** An operation of this process holds the app. */
  isHeld(appId: string): boolean;
  isUserWaiting(appId: string): boolean;
  /** The app's lifecycle lock; throws at once when it is busy or the app is reserved by an update. */
  withAppLock<T>(appId: string, work: () => Promise<T>): Promise<T>;
  /** Lock-free: the app's containers that should run and are Stopped, in start order. null: leave the app alone. */
  stoppedContainers(appId: string): Promise<string[] | null>;
  /**
   * Under the lock: re-check, then start; a database or cache is waited for until it accepts work, or until
   * `yieldNow` says a user wants the app. false: nothing to do any more.
   */
  startContainer(name: string, appId: string, yieldNow: () => boolean): Promise<boolean>;
  /** Under the lock: re-check, then start the dependencies and restart the main container. */
  restartApp(appId: string, options: RestartOptions): Promise<RestartResult>;
  report(event: ReconcileEvent): void | Promise<void>;
}

interface Asked { kind: ReconcileKind; reason: string }

interface AppQueue {
  pending?: Asked;
  /** The request a run is working on right now: it has left `pending`. */
  inFlight?: Asked;
  /** A restart that was pending or in flight when a background pass took the app: asked again at that pass's end. */
  kept?: Asked;
  timer?: unknown;
  running: boolean;
  /** Bumped by a cancel, so a run that was cancelled meanwhile does not put its request back. */
  generation: number;
  yieldingSince?: number;
}

interface ContainerStarts {
  appId: string; at: number[]; paused: boolean; issueRaised: boolean;
  /** The last start was a restart the prober asked for: only a healthy probe clears the record, not "Running". */
  unhealthy?: boolean;
}

export interface ReconcilerState {
  apps: Map<string, AppQueue>;
  starts: Map<string, ContainerStarts>;
}

export function isLockBusy(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AppUpdateExecutorLockBusyError'
    || error.name === 'AppLifecycleBusyError' || error.message.includes('executor lock is busy'));
}

export function createAppReconciler(
  deps: ReconcilerDeps,
  state: ReconcilerState = { apps: new Map(), starts: new Map() },
) {
  const queue = (appId: string): AppQueue => {
    let entry = state.apps.get(appId);
    if (!entry) state.apps.set(appId, entry = { running: false, generation: 0 });
    return entry;
  };

  function schedule(appId: string, delayMs: number): void {
    const entry = queue(appId);
    if (entry.timer !== undefined) return;
    // A timer inherits the context of whoever created it, often the operation whose end asked: the queue's work
    // is nobody's operation (no user wait budget or abort signal, no inherited lock or core admission).
    entry.timer = deps.setTimer(() => outsideOperation(() => {
      entry.timer = undefined;
      void run(appId);
    }), delayMs);
  }

  /** start + start = start; anything + restart = restart. */
  function request(appId: string, kind: ReconcileKind, reason: string): void {
    ask(appId, { kind, reason });
  }

  function ask(appId: string, asked: Asked): void {
    const entry = queue(appId);
    // An operation holds the app: its end asks again, with fresh state.
    if (!entry.running && deps.isHeld(appId)) return;
    if (!entry.pending || (asked.kind === 'restart' && entry.pending.kind === 'start')) entry.pending = asked;
    if (!entry.running) schedule(appId, 0);
  }

  /**
   * An operation took the app: nothing is pending while it runs. A user's operation (the owner's stop, start or
   * uninstall, an update) drops the request for good; its end asks for a plain start with fresh state. A background
   * pass (the 30 s app reconcile, a scheduled backup) only postpones a restart the prober asked for: its end asks
   * for that restart again, and the re-check under the lock still leaves a stopped or reserved app alone. That holds
   * for a restart a run is working on too: the run has taken it out of `pending`, finds the app busy and, being
   * cancelled, does not put it back. If the background operation restarted the app itself, the restart asked again
   * at its end is one too many; it is not told apart (an automatic backup or reconcile pass does not restart apps).
   */
  function cancel(appId: string, keepRestart = false): void {
    const entry = state.apps.get(appId);
    if (!entry) return;
    if (!keepRestart) entry.kept = undefined;
    else if (entry.pending?.kind === 'restart') entry.kept = entry.pending;
    else if (entry.inFlight?.kind === 'restart') entry.kept = entry.inFlight;
    entry.pending = undefined;
    entry.generation += 1;
    entry.yieldingSince = undefined;
    if (entry.timer !== undefined) deps.clearTimer(entry.timer);
    entry.timer = undefined;
  }

  function operation(appId: string, phase: 'begin' | 'end', origin: AppOperationOrigin = 'user'): void {
    if (phase === 'begin') return cancel(appId, origin === 'background');
    const entry = state.apps.get(appId);
    const kept = entry?.kept;
    if (entry) entry.kept = undefined;
    ask(appId, kept ?? { kind: 'start', reason: 'an operation on the app ended' });
  }

  function usersFirst(appId: string, entry: AppQueue): boolean {
    if (!deps.isUserWaiting(appId)) return false;
    entry.yieldingSince ??= deps.now();
    return deps.now() - entry.yieldingSince < USERS_FIRST_MS;
  }

  function retry(appId: string, cause: 'busy' | 'user'): void {
    const delayMs = Math.round(RETRY_MIN_MS + deps.random() * RETRY_SPREAD_MS);
    void deps.report({ type: 'retry', appId, cause, delayMs });
    schedule(appId, delayMs);
  }

  async function run(appId: string): Promise<void> {
    const entry = queue(appId);
    const asked = entry.pending;
    if (!asked || entry.running) return;
    if (usersFirst(appId, entry)) return retry(appId, 'user');
    entry.running = true;
    entry.pending = undefined;
    entry.inFlight = asked;
    const generation = entry.generation;
    let outcome: 'done' | 'busy' | 'user' = 'done';
    let handled = false;
    try {
      outcome = await attempt(appId, asked, entry);
      handled = outcome === 'done';
    } catch (error) {
      if (isLockBusy(error)) outcome = 'busy';
      // An app reserved by an update is its updater's; anything else is seen again at the next observation.
      else if (!(error instanceof Error && error.name === 'AppLifecycleAdmissionError')) {
        void deps.report({ type: 'failed', appId, error });
      }
    } finally {
      entry.running = false;
      entry.inFlight = undefined;
    }
    // The run did its request after all (the background pass that kept it was over before the run needed the lock):
    // it is not asked a second time.
    if (handled) {
      if (entry.kept === asked) entry.kept = undefined;
      if (entry.pending === asked) entry.pending = undefined;
    }
    if (outcome !== 'done' && generation === entry.generation) {
      if (!entry.pending || asked.kind === 'restart') entry.pending = asked;
      return retry(appId, outcome);
    }
    if (outcome === 'done') entry.yieldingSince = undefined;
    // Asked again while this run was busy.
    if (entry.pending) schedule(appId, 0);
  }

  async function attempt(
    appId: string,
    asked: Asked,
    entry: AppQueue,
  ): Promise<'done' | 'user'> {
    const stopped = await deps.stoppedContainers(appId);
    if (!stopped) return 'done';
    const startable = stopped.filter(name => !startsPaused(name));
    if (asked.kind === 'start' && startable.length === 0) return 'done';
    // A start, and the wait for a database after it, can take a minute; a user who came meanwhile gets the app first.
    const yieldNow = () => usersFirst(appId, entry);
    return deps.withAppLock(appId, async () => {
      if (asked.kind === 'restart') {
        // A restart is an automatic start like any other: it counts towards the crash loop and is paused by it.
        const result = await deps.restartApp(appId, { paused: startsPaused, yieldNow });
        for (const name of result.started) {
          await deps.report({ type: 'started', appId, container: name, reason: asked.reason });
          await recordStart(appId, name);
        }
        // The dependencies it started count even when the restart then failed.
        if (result.failure !== undefined) throw result.failure;
        if (result.restarted) {
          await deps.report({ type: 'restarted', appId, reason: asked.reason });
          await recordStart(appId, result.restarted, true);
        }
        return result.yielded ? 'user' : 'done';
      }
      for (const name of startable) {
        if (yieldNow()) return 'user';
        if (!await deps.startContainer(name, appId, yieldNow)) continue;
        await deps.report({ type: 'started', appId, container: name, reason: asked.reason });
        await recordStart(appId, name);
      }
      return 'done';
    });
  }

  // ─── Crash loop: 3 automatic starts in 5 minutes pause the container ───

  function startsPaused(name: string): boolean {
    const record = state.starts.get(name);
    if (!record?.paused) return false;
    // Ten minutes after the last start, one more round is allowed. The issue stays until the container has run.
    if (deps.now() - (record.at.at(-1) ?? 0) <= CRASH_LOOP_CLEAR_MS) return true;
    record.paused = false;
    record.at = [];
    return false;
  }

  async function recordStart(appId: string, name: string, proberRestart = false): Promise<void> {
    const now = deps.now();
    const record: ContainerStarts = state.starts.get(name) ?? { appId, at: [], paused: false, issueRaised: false };
    record.at = [...record.at.filter(at => now - at < CRASH_LOOP_WINDOW_MS), now];
    record.unhealthy = proberRestart;
    state.starts.set(name, record);
    if (record.at.length < CRASH_LOOP_STARTS) return;
    record.paused = true;
    record.issueRaised = true;
    await deps.report({ type: 'crash-loop', appId, container: name, starts: record.at.length });
  }

  /**
   * The watchdog's view of one app container, each tick. A container the watchdog started has recovered when it has
   * run for ten minutes. One the prober had restarted was running all along and did not answer: "Running" says
   * nothing about it, so its record waits for a healthy probe (`observeHealthy`).
   */
  function observeContainer(appId: string, name: string, status: string, shouldRun: boolean): void {
    const record = state.starts.get(name);
    if (record && !record.unhealthy && status === 'Running' && deps.now() - (record.at.at(-1) ?? 0) >= CRASH_LOOP_CLEAR_MS) {
      forget(name, record);
    }
    if (shouldRun && status === 'Stopped' && !startsPaused(name)) {
      request(appId, 'start', `${name} should be running but is Stopped`);
    }
  }

  /**
   * The prober's view of one app, each time all its checks pass: a container whose last automatic start was a
   * prober restart has recovered when the app is healthy ten minutes after that restart.
   */
  function observeHealthy(appId: string): void {
    for (const [name, record] of state.starts) {
      if (record.appId === appId && record.unhealthy && deps.now() - (record.at.at(-1) ?? 0) >= CRASH_LOOP_CLEAR_MS) {
        forget(name, record);
      }
    }
  }

  /** The owner started the app: automatic starts get a fresh count. */
  function resetCrashLoop(appId: string): void {
    for (const [name, record] of state.starts) {
      if (record.appId === appId) forget(name, record);
    }
  }

  function forget(name: string, record: ContainerStarts): void {
    state.starts.delete(name);
    if (record.issueRaised) void deps.report({ type: 'crash-loop-cleared', container: name });
  }

  /**
   * The watchdog's list of every container an install record owns, each tick: the record (and the issue) of a
   * container that is not among them any more, because its app was uninstalled, is forgotten.
   */
  function retainContainers(owned: ReadonlySet<string>): void {
    for (const [name, record] of state.starts) {
      if (!owned.has(name)) forget(name, record);
    }
  }

  return {
    request, cancel, operation, observeContainer, observeHealthy, resetCrashLoop, retainContainers,
    pending: (appId: string) => state.apps.get(appId)?.pending?.kind,
  };
}

export type AppReconciler = ReturnType<typeof createAppReconciler>;

// ─── The Control Panel's reconciler ───

export function shouldSuppressAppRecovery(meta: Pick<InstallMetadata, 'enabled' | 'desiredState' | 'lifecycleOperation'>): boolean {
  return meta.enabled === false || meta.desiredState === 'stopped'
    || (meta.lifecycleOperation?.desiredState === 'stopped' && meta.lifecycleOperation.state !== 'completed');
}

/**
 * The app's containers in the order updates start them (database, cache, sidecar, worker, app), the main container
 * last.
 */
export function startOrder(meta: InstallMetadata): ContainerTarget[] {
  const ordered = orderContainers(containerTargets(meta.containers), 'start');
  const primary = ordered.find(container => container.primary) ?? ordered.at(-1);
  return [...ordered.filter(container => container !== primary), ...(primary ? [primary] : [])];
}

/**
 * After starting a database or cache: wait until it accepts work (`readinessCheck`, as an update's reopen does), so
 * its clients do not start against a database that is still recovering. A container that does not get ready in time
 * is logged and its clients start anyway (they retry; the prober watches the app). The wait happens under the app's
 * lock, so it ends as soon as `yieldNow` says a user wants the app: a user never waits out a database's minute.
 */
async function waitUntilReady(appId: string, name: string, yieldNow: () => boolean = () => false): Promise<void> {
  const meta = await readInstallMetadata(appId);
  const role = meta ? containerRole(meta.containers, name) : undefined;
  if (!meta || (role !== 'database' && role !== 'cache')) return;
  try {
    const { readFrozenUpdateManifest } = await import('../market/frozen-manifest');
    const check = readinessCheck(meta, await readFrozenUpdateManifest(appId), name);
    if (!check) return;
    const { waitForAppHealth, waitForPostgresHealth } = await import('../market/health');
    const ready = check.type === 'postgres'
      ? await waitForPostgresHealth(name, check.user, check.timeoutMs, yieldNow)
      : await waitForAppHealth(name, check.port, check.path, check.timeoutMs, yieldNow);
    if (!ready && !yieldNow()) console.warn(`[app-reconciler] ${appId}: ${name} is running but not ready; starting the rest anyway`);
  } catch (error) {
    console.warn(`[app-reconciler] ${appId}: could not check that ${name} is ready:`, error);
  }
}

/**
 * Start one container that should run and is Stopped. An observation is only a hint: admission and every start
 * condition must hold at action time, and the lock covers the terminal Incus operation. Used by the queue for
 * app containers (inside its app lock) and by the watchdog for the platform's own containers.
 */
export async function startWatchdogContainer(name: string): Promise<boolean> {
  return withContainerLifecycle(name, async () => {
    if (isContainerMaintenanceActive(name)) return false;
    const owners = (await listInstalledApps()).filter(app => app.containers.some(c =>
      (c.containerName) === name));
    if (owners.length > 1 || (name.startsWith('app-') && owners.length !== 1)) return false;
    for (const app of owners) {
      if (shouldSuppressAppRecovery(app) || !(await inspectAppStorage(app.storageVolumes)).available) return false;
    }
    const current = await incusRequest<{ status: string; config: Record<string, string> }>(
      'GET', `/1.0/instances/${encodeURIComponent(name)}`);
    if (current.type === 'error') throw new Error('Cannot verify watchdog start state');
    if (current.metadata?.status !== 'Stopped' || current.metadata?.config?.['boot.autostart'] === 'false') return false;
    const started = await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, { action: 'start', timeout: 30 });
    if (started.type === 'error') throw new Error(started.error || 'Watchdog start failed');
    if (started.operation) await waitForIncusOperation(started.operation, 60);
    return true;
  }, { automatic: true });
}

async function stoppedContainers(appId: string): Promise<string[] | null> {
  if (isAppUpdateReserved(appId)) return null;
  const meta = await readInstallMetadata(appId);
  if (!meta || shouldSuppressAppRecovery(meta)) return null;
  const stopped: string[] = [];
  for (const { name } of startOrder(meta)) {
    if (isContainerMaintenanceActive(name)) continue;
    const current = await incusRequest<{ status: string; config: Record<string, string> }>(
      'GET', `/1.0/instances/${encodeURIComponent(name)}`);
    if (current.type !== 'error' && current.metadata?.status === 'Stopped'
      && current.metadata.config?.['boot.autostart'] !== 'false') stopped.push(name);
  }
  return stopped;
}

async function startAppContainer(name: string, appId: string, yieldNow?: () => boolean): Promise<boolean> {
  if (!await startWatchdogContainer(name)) return false;
  const { applyResourcePolicy } = await import('../infrastructure/resource-policy');
  await applyResourcePolicy(name, 'normal');
  await waitUntilReady(appId, name, yieldNow);
  return true;
}

async function instanceNow(name: string): Promise<{ status?: string; autostart: boolean }> {
  const current = await incusRequest<{ status: string; config: Record<string, string> }>(
    'GET', `/1.0/instances/${encodeURIComponent(name)}`);
  if (current.type === 'error') throw new Error(`Cannot verify the state of ${name} before an automatic restart`);
  return { status: current.metadata?.status, autostart: current.metadata?.config?.['boot.autostart'] !== 'false' };
}

/**
 * The prober asked for a restart: dependencies started and ready, then the main container restarted. Every
 * condition of an automatic start holds here too: the owner's stop, maintenance, storage, a reservation
 * (`withContainerLifecycle`), `boot.autostart=false` and the crash-loop pause each leave the app as it is.
 */
export async function restartApp(
  appId: string,
  options: RestartOptions = { paused: () => false, yieldNow: () => false },
): Promise<RestartResult> {
  const started: string[] = [];
  const meta = await readInstallMetadata(appId);
  if (!meta || shouldSuppressAppRecovery(meta)) return { started };
  const ordered = startOrder(meta);
  const primary = ordered.pop();
  if (!primary || [primary, ...ordered].some(({ name }) => isContainerMaintenanceActive(name))) return { started };
  if (!(await inspectAppStorage(meta.storageVolumes)).available) return { started };
  const main = await instanceNow(primary.name);
  if (!main.autostart || options.paused(primary.name)) return { started };
  try {
    // Its dependencies run first, in start order, each database or cache ready before the next.
    for (const dependency of ordered) {
      if (options.yieldNow()) return { started, yielded: true };
      if (await containerState(dependency.name) !== 'Stopped') continue;
      // A dependency in a crash loop stays paused, and the main container is not restarted against it.
      if (options.paused(dependency.name)) return { started };
      if (await startAppContainer(dependency.name, appId, options.yieldNow)) started.push(dependency.name);
    }
    // The stop below can take the main container's whole timeout under the lock: a waiting user goes before it.
    if (options.yieldNow()) return { started, yielded: true };
    // The main container: a clean restart, forced (logged) after AUTOMATIC_RESTART_STOP_SEC; started if it is not
    // running. The prober restarts an app that stopped answering, so a short clean window is enough, and it keeps the
    // lock shorter than a user waits for it (USER_OPERATION_LOCK_WAIT_MS). Starting the dependencies and waiting for
    // them can take minutes, so the main container's state is read again here, not taken from before.
    const now = await instanceNow(primary.name);
    if (!now.autostart) return { started };
    if (now.status === 'Running') {
      await withContainerLifecycle(primary.name,
        () => restartContainer(primary.name, { timeoutSec: Math.min(stopTimeoutSec(primary.role), AUTOMATIC_RESTART_STOP_SEC) }),
        { automatic: true });
    } else if (!await startAppContainer(primary.name, appId, options.yieldNow)) {
      return { started };
    }
  } catch (failure) {
    // With nothing started the failure is simply thrown; otherwise the queue counts the starts first.
    if (started.length === 0) throw failure;
    return { started, failure };
  }
  return { started, restarted: primary.name };
}

async function report(event: ReconcileEvent): Promise<void> {
  try {
    if (event.type === 'retry') {
      console.log(`[app-reconciler] ${event.appId}: ${event.cause === 'user' ? 'a user operation goes first' : 'busy'}, retrying in ${(event.delayMs / 1000).toFixed(1)}s`);
    } else if (event.type === 'failed') {
      console.error(`[app-reconciler] ${event.appId}: automatic recovery failed:`, event.error);
    } else if (event.type === 'started') {
      console.log(`[app-reconciler] ${event.appId}: started ${event.container} (${event.reason})`);
    } else if (event.type === 'restarted') {
      console.log(`[app-reconciler] ${event.appId}: restarted (${event.reason})`);
      const { recordTimelineEvent } = await import('../health/issues');
      await recordTimelineEvent({
        id: `app.${event.appId}.restart.${Date.now()}`,
        source: 'app-prober',
        title: `${event.appId} restarted automatically`,
        body: event.reason,
      });
    } else if (event.type === 'crash-loop') {
      // Paused, not stopped for good: startsPaused allows one more round 10 minutes after the last start.
      const body = `${event.container} failed to stay running after ${event.starts} starts in 5 minutes. `
        + 'Automatic starts are paused; one more try 10 minutes after the last start.';
      console.error(`[app-reconciler] ${event.appId}: ${event.container} keeps crashing; automatic starts paused, one more try in 10 minutes`);
      const { observeIssue } = await import('../health/issues');
      await observeIssue({
        id: `container.${event.container}.crash-loop`,
        severity: 'error',
        source: 'watchdog',
        title: `${event.container} keeps crashing`,
        body,
        fixable: false,
        debounce: 1,
      });
      const { sendNotificationToUI } = await import('../health/notification-bridge');
      await sendNotificationToUI({
        title: `${event.container} keeps crashing`, message: body, type: 'error', source: 'system', userId: null,
        actionUrl: '/settings/system/health',
      });
    } else {
      console.log(`[app-reconciler] ${event.container}: crash-loop record cleared`);
      const { resolveIssue } = await import('../health/issues');
      await resolveIssue(`container.${event.container}.crash-loop`);
    }
  } catch (error) {
    console.error('[app-reconciler] could not report:', error);
  }
}

// Next may bundle this module more than once: one reconciler for the whole process.
const reconcilerKey = Symbol.for('youeye.app-reconciler');
const reconcilerGlobal = globalThis as typeof globalThis & { [reconcilerKey]?: AppReconciler };

export function appReconciler(): AppReconciler {
  return reconcilerGlobal[reconcilerKey] ??= createAppReconciler({
    now: () => Date.now(),
    random: () => Math.random(),
    setTimer: (run, delayMs) => setTimeout(run, delayMs),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    isHeld: isAppHeld,
    isUserWaiting: isUserOperationWaiting,
    withAppLock: (appId, work) => withAppLifecycle(appId, work, { automatic: true }),
    stoppedContainers,
    startContainer: startAppContainer,
    restartApp,
    report,
  });
}

/** Called once by instrumentation.ts: from here on every lifecycle operation cancels and re-triggers the queue. */
export function startAppReconciler(): void {
  setAppOperationListener((appId, phase, origin) => appReconciler().operation(appId, phase, origin));
}
