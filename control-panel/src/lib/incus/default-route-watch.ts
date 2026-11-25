import type { Duplex } from 'node:stream';
import { createDefaultRouteGuard, type GuardDeps } from './default-route-guard';
import { instanceOfSource, watchLifecycleEvents, type LifecycleEvent } from './incus-events';

const STARTED = new Set(['instance-started', 'instance-restarted']);
const SWEEP_MS = 30_000;
/**
 * Sweeps after the stream opens, from the moment it opened (YE-214). With Incus listening at the first try (YE-207)
 * the stream opens while Incus is still starting the apps: one that is not Running at the opening sweep, and whose
 * start event came before the subscription was live, is caught by one of these.
 */
const AFTER_OPEN_MS = [5_000, 15_000, 30_000];
/** Then a slow sweep while the stream is up: a missed start is repaired within a minute (unchanged pids cost nothing). */
const PERIODIC_MS = 60_000;

export interface WatchDeps extends GuardDeps {
  open(onReady: () => void): Duplex;
  waitForIncus(): Promise<void>;
}

/**
 * Run the default-route guard for the life of the process (YE-198). Incus lifecycle events trigger a repair after
 * each container start, about as soon as its DHCP leases are in. Each time the event stream (re)connects, a sweep
 * repairs every running container that started since its last repair (at Control Panel start: all of them, which
 * covers a box reboot, where Incus starts the apps before the Control Panel), again 5, 15 and 30 s later, and then
 * every minute while the stream is up (YE-214: an app that starts while the stream connects sends its start event
 * before the subscription is live). While the stream is down, the sweep runs every 30 s instead.
 */
export function runDefaultRouteWatch(
  deps: WatchDeps,
  guard: ReturnType<typeof createDefaultRouteGuard> = createDefaultRouteGuard(deps),
  stop?: AbortSignal,
): Promise<void> {
  // A failing sweep is logged once until one succeeds (Incus down for a while must not fill the log).
  let sweepFailing = false;
  const sweep = (why: string) => guard.sweep(why).then(() => { sweepFailing = false; }, (error) => {
    if (!sweepFailing) deps.log(`default route sweep (${why}) failed: ${error instanceof Error ? error.message : String(error)}`);
    sweepFailing = true;
  });
  const onEvent = (event: LifecycleEvent) => {
    if (!STARTED.has(event.action) || (event.project && event.project !== 'default')) return;
    const name = instanceOfSource(event.source);
    if (name) void guard.schedule(name, event.action);
  };
  // Each opened stream gets a generation; its follow-up sweeps stop once it closed.
  let generation = 0;
  const followUp = (opened: number) => {
    for (const delay of AFTER_OPEN_MS) {
      void deps.sleep(delay).then(() => (opened === generation && !stop?.aborted ? sweep('after the stream opened') : undefined));
    }
    void (async () => {
      await deps.sleep(AFTER_OPEN_MS[AFTER_OPEN_MS.length - 1]);
      while (opened === generation && !stop?.aborted) {
        await deps.sleep(PERIODIC_MS);
        if (opened !== generation || stop?.aborted) return;
        await sweep('periodic');
      }
    })();
  };
  return (async () => {
    let downLogged = false;
    let current: { close(): void } | undefined;
    stop?.addEventListener('abort', () => current?.close(), { once: true });
    while (!stop?.aborted) {
      try {
        await deps.waitForIncus();
        const stream = watchLifecycleEvents(deps.open, onEvent, () => {
          deps.log(downLogged ? 'Incus event stream is back' : 'watching Incus lifecycle events');
          downLogged = false;
          void sweep('stream opened');
          followUp(generation);
        });
        current = stream;
        await stream.closed.finally(() => { generation++; });
      } catch (error) {
        if (!downLogged) deps.log(`Incus event stream unavailable (${error instanceof Error ? error.message : String(error)}); sweeping every 30 s`);
        downLogged = true;
      }
      if (stop?.aborted) break;
      await sweep('stream down');
      await deps.sleep(SWEEP_MS);
    }
  })();
}

/** The process-wide guard, also used right after a connection NIC is hot-plugged. */
let shared: Promise<{ deps: WatchDeps; guard: ReturnType<typeof createDefaultRouteGuard> }> | undefined;

async function serverDeps(): Promise<WatchDeps> {
  const { incusRequest, execShell, openIncusConnection } = await import('./server');
  const { waitForIncusReady } = await import('./readiness');
  const { isAppHeld } = await import('@/lib/market/update-admission');
  return {
    incus: (method, path) => incusRequest(method, path),
    exec: (container, script) => execShell(container, script, { timeout: 15_000 }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(`[default-route] ${message}`),
    open: (onReady) => openIncusConnection(onReady),
    waitForIncus: () => waitForIncusReady(),
    busy: (instance) => {
      const appId = instance.config?.['user.youeye.app_id'];
      return Boolean(appId && isAppHeld(appId));
    },
  };
}

function sharedGuard() {
  shared ??= serverDeps().then((deps) => ({ deps, guard: createDefaultRouteGuard(deps) }));
  return shared;
}

export async function defaultRouteGuard(): Promise<ReturnType<typeof createDefaultRouteGuard>> {
  return (await sharedGuard()).guard;
}

export async function startDefaultRouteWatch(): Promise<void> {
  const { deps, guard } = await sharedGuard();
  void runDefaultRouteWatch(deps, guard).catch((error) => {
    console.error(`[default-route] watch stopped: ${error instanceof Error ? error.message : String(error)}`);
  });
}
