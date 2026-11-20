import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

import {
  CRASH_LOOP_CLEAR_MS, USERS_FIRST_MS, createAppReconciler, type ReconcileEvent,
} from '../src/lib/apps/app-reconciler';
import { FIRST_DELAY_MS, jitteredDelay, startJitteredLoop } from '../src/lib/health/jittered-timer';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import {
  isAppHeld, isAppHeldByCaller, isUserOperationWaiting, setAppOperationListener, withAppLifecycle,
  withPlatformLifecycle, withUserOperationLockWait,
} from '../src/lib/market/update-admission';
import { AppUpdateExecutorLock } from '../src/lib/market/update-executor-lock';

/** A clock the test moves. Timers run in order; promises settle between them. */
class Clock {
  t = 0;
  private timers: Array<{ at: number; run: () => void }> = [];
  now = () => this.t;
  setTimer = (run: () => void, delayMs: number) => {
    const timer = { at: this.t + delayMs, run };
    this.timers.push(timer);
    return timer;
  };
  clearTimer = (timer: unknown) => { this.timers = this.timers.filter(candidate => candidate !== timer); };
  sleep = (ms: number) => new Promise<void>(resolve => this.setTimer(resolve, ms));
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const next = this.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      this.clearTimer(next);
      next.run();
    }
    this.t = end;
    await settle();
  }
}
async function settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }

const busyError = () => Object.assign(new Error('App update executor lock is busy'), { name: 'AppUpdateExecutorLockBusyError' });
const reservedError = () => Object.assign(new Error('reserved'), { name: 'AppLifecycleAdmissionError' });

/** One app (`memos`: a database and a main container) on a fake box, with the real queue. */
function box() {
  const clock = new Clock();
  const containers = new Map([['app-memos-db', 'Running'], ['app-memos', 'Running']]);
  const world = {
    clock, containers,
    held: false,          // an operation of this process holds the app
    lockedElsewhere: false, // the flock is held by something the marker cannot see
    reserved: false,      // an update owns the app
    userWaiting: false,
    stopIntent: false,
    restartFails: false,  // the main container's restart fails after the dependencies were started
    readMs: 0,            // how long the lock-free read of the app's containers takes
    startMs: 0,
    readyMs: 0,           // how long a started container takes to accept work
    lockedMs: [] as number[], // how long each hold of the app lock lasted
    starts: [] as Array<{ name: string; at: number }>,
    restarts: [] as number[],
    events: [] as ReconcileEvent[],
    locks: 0,
    afterLock: undefined as undefined | (() => void), // runs as the app lock is let go, before the run's own end
  };
  let locked = false;
  const reconciler = createAppReconciler({
    now: clock.now, random: () => 0.5, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    isHeld: () => world.held,
    isUserWaiting: () => world.userWaiting,
    async withAppLock(_appId, work) {
      if (world.reserved) throw reservedError();
      if (locked || world.held || world.lockedElsewhere) throw busyError();
      locked = true; world.locks += 1;
      const took = clock.t;
      try { return await work(); } finally {
        locked = false; world.lockedMs.push(clock.t - took);
        world.afterLock?.();
      }
    },
    async stoppedContainers() {
      if (world.readMs) await clock.sleep(world.readMs);
      if (world.stopIntent) return null;
      return [...containers].filter(([, status]) => status === 'Stopped').map(([name]) => name);
    },
    async startContainer(name, _appId, yieldNow) {
      assert.ok(locked, 'a start happens under the app lock');
      if (world.stopIntent || containers.get(name) !== 'Stopped') return false;
      if (world.startMs) await clock.sleep(world.startMs);
      containers.set(name, 'Running');
      world.starts.push({ name, at: clock.t });
      // Ready is polled, as the real wait does.
      for (let waited = 0; waited < world.readyMs && !yieldNow(); waited += 1_000) await clock.sleep(1_000);
      return true;
    },
    async restartApp(_appId, options) {
      assert.ok(locked, 'a restart happens under the app lock');
      const started: string[] = [];
      if (world.stopIntent || options.paused('app-memos')) return { started };
      if (containers.get('app-memos-db') === 'Stopped') {
        if (options.paused('app-memos-db')) return { started };
        if (world.startMs) await clock.sleep(world.startMs);
        containers.set('app-memos-db', 'Running');
        started.push('app-memos-db');
      }
      if (world.restartFails) return { started, failure: new Error('app-memos could not start after its stop') };
      if (options.yieldNow()) return { started, yielded: true };
      containers.set('app-memos', 'Running');
      world.restarts.push(clock.t);
      return { started, restarted: 'app-memos' };
    },
    report: event => { world.events.push(event); },
  });
  /** What a watchdog tick does for this app. */
  const watchdogTick = () => {
    for (const [name, status] of containers) reconciler.observeContainer('memos', name, status, !world.stopIntent);
  };
  return { ...world, world, reconciler, watchdogTick };
}

/** The real prober with every dependency replaced; `withAppLifecycle` must never be reached. */
function prober(f: ReturnType<typeof box>, options: { httpMs?: number; httpOk?: boolean } = {}) {
  const calls = { lifecycle: 0, incusWrites: 0, healthy: 0, statuses: [] as string[], requests: [] as string[] };
  const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(), 'src/lib/market/app-prober.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api: any = {};
  const meta = () => ({
    appId: 'memos', installedAt: '2026-01-01T00:00:00Z',
    enabled: !f.world.stopIntent, desiredState: f.world.stopIntent ? 'stopped' : 'running',
    containers: [
      { name: 'db', containerName: 'app-memos-db', type: 'oci' },
      { name: 'main', containerName: 'app-memos', type: 'oci', primary: true, port: 5230, healthCheck: { type: 'http', retries: 1 } },
    ],
  });
  runInNewContext(code, {
    exports: api, console, Date: { now: f.clock.now, parse: Date.parse }, AbortSignal,
    async fetch() {
      await f.clock.sleep(options.httpMs ?? 0);
      if (options.httpOk === false || f.containers.get('app-memos') !== 'Running') throw new Error('connection refused');
      return { ok: true, status: 200 };
    },
    require(id: string) {
      if (id.endsWith('update-admission')) return {
        isAppHeld: () => f.world.held, isAppHeldByCaller: () => false, isAppUpdateReserved: () => f.world.reserved,
        withAppLifecycle() { calls.lifecycle += 1; throw new Error('the prober took the lifecycle lock'); },
        withContainerLifecycle() { calls.lifecycle += 1; throw new Error('the prober took the lifecycle lock'); },
      };
      if (id.endsWith('app-reconciler')) return {
        shouldSuppressAppRecovery: (m: any) => m.enabled === false || m.desiredState === 'stopped',
        appReconciler: () => ({
          request(appId: string, kind: 'start' | 'restart', reason: string) {
            calls.requests.push(kind); f.reconciler.request(appId, kind, reason);
          },
          observeHealthy(appId: string) { calls.healthy += 1; f.reconciler.observeHealthy(appId); },
        }),
      };
      if (id.endsWith('installed-apps')) return {
        async getAllInstalledApps() { return [{ appId: 'memos' }]; },
        async updateHealthProbeState() {},
        async updateHealthStatus(_id: string, _status: string, detail: { appHealthState: string }) { calls.statuses.push(detail.appHealthState); },
      };
      if (id.endsWith('metadata')) return { readInstallMetadata: async () => meta() };
      if (id.endsWith('oci-deployer')) return {
        containerExists: async (name: string) => f.containers.has(name), getContainerIP: async () => '10.0.0.2',
      };
      if (id.endsWith('incus/server')) return {
        async incusRequest(method: string, route: string) {
          if (method !== 'GET') { calls.incusWrites += 1; throw new Error('the prober changed a container'); }
          return { metadata: { status: f.containers.get(route.split('/')[3]) } };
        },
        async execShell() { return { exitCode: 0, stdout: '' }; },
      };
      if (id.endsWith('health/issues')) return { async observeIssue() {}, async resolveIssue() {} };
      if (id.endsWith('container-maintenance')) return { isContainerMaintenanceActive: () => false };
      if (id.endsWith('storage')) return { inspectAppStorage: async () => ({ available: true }) };
      throw new Error(`Unexpected dependency ${id}`);
    },
  });
  return { calls, probe: () => api.probeInstalledApps() as Promise<Array<{ appId: string; state: string; detail: string }>> };
}

// ─── The starvation case ───

test('prober and watchdog in step, the probe running while the container stops: started within 10 s', async () => {
  const f = box();
  const p = prober(f, { httpMs: 8_000 });
  // Both ticks fall on the same instant, the prober first, and its probe of the app takes 8 s (a slow health check).
  // Before, the probe held the app's lock for those 8 s and the watchdog's start failed "busy" on every tick.
  const probing = p.probe();
  await f.clock.advance(100);
  f.containers.set('app-memos', 'Stopped');
  const stoppedAt = f.clock.t;
  f.watchdogTick();
  await f.clock.advance(10_000 - 100);
  assert.equal(f.containers.get('app-memos'), 'Running');
  assert.equal(f.starts.length, 1);
  assert.ok(f.starts[0].at - stoppedAt <= 10_000, `started after ${f.starts[0].at - stoppedAt} ms`);
  assert.ok(f.starts[0].at < 8_000, 'started while the probe was still running');
  assert.deepEqual(f.events.filter(event => event.type === 'retry'), [], 'never busy');
  await probing;
  assert.equal(p.calls.lifecycle, 0, 'the prober never takes the lifecycle lock');
});

test('the prober never takes the lock, never changes a container, and hands a restart to the queue', async () => {
  const f = box();
  const p = prober(f, { httpOk: false });
  f.clock.t = 60_000; // past the first restart backoff
  const probing = p.probe();
  await f.clock.advance(0);
  const [result] = await probing;
  assert.equal(result.state, 'starting');
  assert.deepEqual(p.calls.requests, ['restart'], 'the restart verdict is a request');
  assert.equal(p.calls.lifecycle, 0);
  assert.equal(p.calls.incusWrites, 0);
  await f.clock.advance(0);
  assert.deepEqual(f.restarts, [60_000], 'the queue restarted the app, under its lock');
  assert.equal(f.world.locks, 1);
});

test('a held app is busy and a reserved app is in maintenance: neither is probed, counted or restarted', async () => {
  const f = box();
  const p = prober(f, { httpOk: false });
  f.world.held = true;
  let [result] = await p.probe();
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /Busy with another operation/);
  f.world.held = false;
  f.world.reserved = true;
  [result] = await p.probe();
  assert.equal(result.state, 'maintenance');
  assert.deepEqual(p.calls.requests, []);
  assert.deepEqual(p.calls.statuses, ['maintenance'], 'busy publishes nothing, maintenance is published');
  assert.equal(p.calls.lifecycle, 0);
});

test('an operation that takes the app while its probe runs turns the verdict into busy', async () => {
  const f = box();
  const p = prober(f, { httpMs: 3_000, httpOk: false });
  const probing = p.probe();
  await f.clock.advance(1_000);
  f.world.held = true; // an update stops the containers now
  f.containers.set('app-memos', 'Stopped');
  await f.clock.advance(3_000);
  const [result] = await probing;
  assert.match(result.detail, /Busy with another operation/);
  assert.deepEqual(p.calls.requests, []);
});

// ─── The queue ───

test('requests for one app merge: start + start = start, start + restart = restart', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.reconciler.request('memos', 'start', 'one');
  f.reconciler.request('memos', 'start', 'two');
  assert.equal(f.reconciler.pending('memos'), 'start');
  f.reconciler.request('memos', 'restart', 'three');
  f.reconciler.request('memos', 'start', 'four');
  assert.equal(f.reconciler.pending('memos'), 'restart');
  await f.clock.advance(0);
  assert.deepEqual(f.restarts, [0]);
  assert.deepEqual(f.starts, [], 'one action for four requests');
  assert.equal(f.world.locks, 1);
  assert.equal(f.reconciler.pending('memos'), undefined);
});

test('a start request with nothing stopped takes no lock', async () => {
  const f = box();
  f.reconciler.operation('memos', 'end');
  await f.clock.advance(0);
  assert.equal(f.world.locks, 0);
});

test('stopped containers start in order under one lock', async () => {
  const f = box();
  f.containers.set('app-memos-db', 'Stopped');
  f.containers.set('app-memos', 'Stopped');
  f.watchdogTick();
  await f.clock.advance(0);
  assert.deepEqual(f.starts.map(start => start.name), ['app-memos-db', 'app-memos']);
  assert.equal(f.world.locks, 1);
});

test("the owner's stop cancels a pending start, and the re-check after it leaves the app stopped", async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.watchdogTick();
  assert.equal(f.reconciler.pending('memos'), 'start');
  // The stop takes the app before the queue's timer runs.
  f.reconciler.operation('memos', 'begin');
  f.world.held = true;
  assert.equal(f.reconciler.pending('memos'), undefined);
  f.watchdogTick(); // a tick during the operation asks for nothing
  assert.equal(f.reconciler.pending('memos'), undefined);
  f.world.stopIntent = true;
  f.containers.set('app-memos-db', 'Stopped');
  f.world.held = false;
  f.reconciler.operation('memos', 'end');
  await f.clock.advance(60_000);
  assert.deepEqual(f.starts, []);
  assert.equal(f.world.locks, 0);
});

test('an operation that leaves a container stopped is repaired at once when it ends', async () => {
  const f = box();
  f.reconciler.operation('memos', 'begin');
  f.world.held = true;
  f.containers.set('app-memos', 'Stopped');
  await f.clock.advance(30_000);
  assert.deepEqual(f.starts, [], 'nothing while the operation holds the app');
  f.world.held = false;
  f.reconciler.operation('memos', 'end');
  await f.clock.advance(0);
  assert.deepEqual(f.starts, [{ name: 'app-memos', at: 30_000 }]);
});

test('a busy app is asked again within 2–5 s, not at the next tick', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.world.lockedElsewhere = true; // a holder the marker cannot see
  f.watchdogTick();
  await f.clock.advance(7_000);
  assert.deepEqual(f.starts, []);
  const retries = f.events.filter(event => event.type === 'retry');
  assert.equal(retries.length, 3, 'tried at 0, 3.5 and 7 s');
  for (const retry of retries) assert.ok(retry.type === 'retry' && retry.cause === 'busy' && retry.delayMs >= 2_000 && retry.delayMs <= 5_000);
  f.world.lockedElsewhere = false;
  await f.clock.advance(5_000);
  assert.equal(f.starts.length, 1);
  assert.ok(f.starts[0].at <= 12_000);
  assert.equal(f.reconciler.pending('memos'), undefined);
});

test('a cancel while the queue was busy drops the request for good', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.world.lockedElsewhere = true;
  f.watchdogTick();
  await f.clock.advance(1_000);
  f.reconciler.cancel('memos');
  f.world.lockedElsewhere = false;
  await f.clock.advance(60_000);
  assert.deepEqual(f.starts, []);
});

test('a background pass that takes the app postpones a pending restart; its end asks for the restart again', async () => {
  const f = box();
  f.world.lockedElsewhere = true; // the queue is retrying a busy app
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(1_000);
  assert.equal(f.reconciler.pending('memos'), 'restart');
  // The 30 s app reconcile takes the app. Before, its begin dropped the restart and its end asked for a start,
  // which does nothing for a Running but unhealthy app.
  f.world.lockedElsewhere = false;
  f.reconciler.operation('memos', 'begin', 'background');
  f.world.held = true;
  assert.equal(f.reconciler.pending('memos'), undefined, 'nothing is pending while the pass holds the app');
  await f.clock.advance(10_000);
  assert.deepEqual(f.restarts, []);
  f.world.held = false;
  f.reconciler.operation('memos', 'end', 'background');
  assert.equal(f.reconciler.pending('memos'), 'restart');
  await f.clock.advance(0);
  assert.deepEqual(f.restarts, [11_000]);
  // Once: the next pass has nothing to ask again.
  f.reconciler.operation('memos', 'begin', 'background');
  f.reconciler.operation('memos', 'end', 'background');
  await f.clock.advance(60_000);
  assert.equal(f.restarts.length, 1);
});

test("a user's operation drops a pending restart for good, also one a background pass had postponed", async () => {
  const f = box();
  f.world.lockedElsewhere = true;
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(1_000);
  f.world.lockedElsewhere = false;
  f.reconciler.operation('memos', 'begin', 'background');
  f.reconciler.operation('memos', 'begin', 'user'); // e.g. the owner restarts or updates the app right after
  f.reconciler.operation('memos', 'end', 'user');
  await f.clock.advance(60_000);
  assert.deepEqual(f.restarts, [], 'the stale verdict restarts nothing');

  // The owner's stop: the postponed restart is asked again and the re-check under the lock leaves the app alone.
  f.world.lockedElsewhere = true;
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(1_000);
  f.world.lockedElsewhere = false;
  f.reconciler.operation('memos', 'begin', 'background');
  f.world.stopIntent = true; // another process recorded the owner's stop meanwhile
  f.reconciler.operation('memos', 'end', 'background');
  await f.clock.advance(60_000);
  assert.deepEqual(f.restarts, []);
});

test('a cancel forgets how long the queue has been yielding to users', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.world.userWaiting = true;
  f.watchdogTick();
  await f.clock.advance(USERS_FIRST_MS - 10_000);
  // The user's operation takes the app and leaves the container stopped; later other users wait again.
  f.reconciler.operation('memos', 'begin');
  f.reconciler.operation('memos', 'end');
  await f.clock.advance(20_000);
  assert.deepEqual(f.starts, [], 'the two minutes count from the new wait, not from the one before the cancel');
  await f.clock.advance(USERS_FIRST_MS);
  assert.equal(f.starts.length, 1);
});

test('a waiting user goes first', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.world.userWaiting = true;
  f.watchdogTick();
  await f.clock.advance(10_000);
  assert.deepEqual(f.starts, []);
  assert.equal(f.world.locks, 0, 'the queue did not take the lock in front of the user');
  assert.ok(f.events.every(event => event.type === 'retry' && event.cause === 'user'));
  f.world.userWaiting = false;
  await f.clock.advance(5_000);
  assert.equal(f.starts.length, 1);
});

test('a user who arrives between two starts gets the app before the second', async () => {
  const f = box();
  f.containers.set('app-memos-db', 'Stopped');
  f.containers.set('app-memos', 'Stopped');
  f.world.startMs = 20_000;
  f.watchdogTick();
  await f.clock.advance(10_000);
  f.world.userWaiting = true;
  await f.clock.advance(10_000);
  assert.deepEqual(f.starts.map(start => start.name), ['app-memos-db']);
  f.world.userWaiting = false;
  await f.clock.advance(30_000);
  assert.deepEqual(f.starts.map(start => start.name), ['app-memos-db', 'app-memos']);
});

test('a user who arrives while a started database gets ready does not wait for it: the lock is given back', async () => {
  const f = box();
  f.containers.set('app-memos-db', 'Stopped');
  f.containers.set('app-memos', 'Stopped');
  f.world.readyMs = 60_000; // the database recovers for a minute
  f.watchdogTick();
  await f.clock.advance(5_000);
  f.world.userWaiting = true;
  await f.clock.advance(2_000);
  assert.deepEqual(f.world.lockedMs, [6_000], 'released at the next readiness poll, not after the minute');
  assert.deepEqual(f.starts.map(start => start.name), ['app-memos-db']);
  f.world.userWaiting = false;
  await f.clock.advance(5_000);
  assert.deepEqual(f.starts.map(start => start.name), ['app-memos-db', 'app-memos'], 'the rest starts once the user is done');
});

test('a restart gives way to a waiting user before it stops the main container, and is asked again', async () => {
  const f = box();
  f.containers.set('app-memos-db', 'Stopped');
  f.world.startMs = 10_000;
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(5_000);
  f.world.userWaiting = true; // arrives while the database starts
  await f.clock.advance(5_000);
  assert.equal(f.containers.get('app-memos-db'), 'Running');
  assert.deepEqual(f.restarts, [], 'the main container is not stopped in front of the user');
  assert.deepEqual(f.world.lockedMs, [10_000]);
  assert.equal(f.reconciler.pending('memos'), 'restart', 'still asked');
  f.world.userWaiting = false;
  await f.clock.advance(5_000);
  assert.equal(f.restarts.length, 1);
  assert.equal(f.reconciler.pending('memos'), undefined);
});

test('behind users an automatic start waits two minutes at most, then takes its turn', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.world.userWaiting = true; // users keep coming
  f.watchdogTick();
  await f.clock.advance(USERS_FIRST_MS - 1);
  assert.deepEqual(f.starts, []);
  await f.clock.advance(5_001);
  assert.equal(f.starts.length, 1);
  assert.ok(f.starts[0].at <= USERS_FIRST_MS + 5_000);
});

test('an app reserved by an update is never touched and never retried', async () => {
  const f = box();
  f.containers.set('app-memos', 'Stopped');
  f.world.reserved = true;
  f.watchdogTick();
  f.reconciler.request('memos', 'restart', 'probe verdict');
  await f.clock.advance(10 * 60_000);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.restarts, []);
  assert.equal(f.world.locks, 0);
  assert.deepEqual(f.events, [], 'no retry, no failure');
});

// ─── Crash loop ───

test('three automatic starts in five minutes pause the container; ten minutes running clear it', async () => {
  const f = box();
  const crash = async () => { f.containers.set('app-memos', 'Stopped'); f.watchdogTick(); await f.clock.advance(60_000); };
  await crash(); await crash(); await crash();
  assert.equal(f.starts.length, 3);
  assert.deepEqual(f.events.filter(event => event.type === 'crash-loop'),
    [{ type: 'crash-loop', appId: 'memos', container: 'app-memos', starts: 3 }]);
  await crash();
  assert.equal(f.starts.length, 3, 'paused');
  f.reconciler.operation('memos', 'end');
  await f.clock.advance(0);
  assert.equal(f.starts.length, 3, 'paused for every source of requests');

  // The owner's start resets it.
  f.reconciler.resetCrashLoop('memos');
  assert.equal(f.events.at(-1)?.type, 'crash-loop-cleared');
  f.watchdogTick();
  await f.clock.advance(0);
  assert.equal(f.starts.length, 4);

  // One start is on record. Ten minutes of running forget it; without an issue there is nothing to clear.
  await f.clock.advance(CRASH_LOOP_CLEAR_MS);
  f.watchdogTick();
  const cleared = f.events.filter(event => event.type === 'crash-loop-cleared').length;
  await crash(); await crash();
  assert.equal(f.starts.length, 6, 'a fresh count: two more starts are not a crash loop');
  assert.equal(f.events.filter(event => event.type === 'crash-loop').length, 1);
  assert.equal(f.events.filter(event => event.type === 'crash-loop-cleared').length, cleared);
});

test('restarts the prober asks for count as automatic starts: three in five minutes pause them too', async () => {
  const f = box();
  const unhealthy = async () => { f.reconciler.request('memos', 'restart', 'L3 failed'); await f.clock.advance(60_000); };
  await unhealthy(); await unhealthy(); await unhealthy();
  assert.equal(f.restarts.length, 3);
  assert.deepEqual(f.events.filter(event => event.type === 'crash-loop'),
    [{ type: 'crash-loop', appId: 'memos', container: 'app-memos', starts: 3 }]);
  await unhealthy();
  assert.equal(f.restarts.length, 3, 'a restart of a paused container is not done');
  // Starts and restarts share one count, and the watchdog's start is paused by it as well.
  f.containers.set('app-memos', 'Stopped');
  f.watchdogTick();
  await f.clock.advance(0);
  assert.deepEqual(f.starts, []);
  // One more round ten minutes after the last one.
  await f.clock.advance(CRASH_LOOP_CLEAR_MS);
  await unhealthy();
  assert.equal(f.restarts.length, 4);

  // A dependency the restart had to start is counted too, and one in a crash loop is not started by a restart.
  const g = box();
  const crash = async () => { g.containers.set('app-memos-db', 'Stopped'); g.watchdogTick(); await g.clock.advance(60_000); };
  await crash(); await crash();
  g.containers.set('app-memos-db', 'Stopped');
  g.reconciler.request('memos', 'restart', 'L1 failed');
  await g.clock.advance(0);
  assert.equal(g.events.filter(event => event.type === 'crash-loop' && event.container === 'app-memos-db').length, 1);
  g.containers.set('app-memos-db', 'Stopped');
  g.reconciler.request('memos', 'restart', 'L1 failed');
  await g.clock.advance(0);
  assert.equal(g.containers.get('app-memos-db'), 'Stopped');
  assert.equal(g.restarts.length, 1, 'the main container is not restarted against a paused database');
});

test('a restart that failed after starting a dependency counts that start, and reports the failure', async () => {
  const f = box();
  f.world.restartFails = true;
  const unhealthy = async () => {
    f.containers.set('app-memos-db', 'Stopped');
    f.reconciler.request('memos', 'restart', 'L1 failed');
    await f.clock.advance(60_000);
  };
  await unhealthy(); await unhealthy(); await unhealthy();
  assert.equal(f.events.filter(event => event.type === 'started' && event.container === 'app-memos-db').length, 3);
  assert.equal(f.events.filter(event => event.type === 'failed').length, 3);
  assert.equal(f.events.filter(event => event.type === 'restarted').length, 0);
  assert.deepEqual(f.events.filter(event => event.type === 'crash-loop'),
    [{ type: 'crash-loop', appId: 'memos', container: 'app-memos-db', starts: 3 }]);
});

test('an app that runs but never gets healthy keeps its crash-loop issue: only a healthy probe clears it', async () => {
  const f = box();
  const unhealthy = async () => { f.reconciler.request('memos', 'restart', 'L3 failed'); await f.clock.advance(60_000); };
  await unhealthy(); await unhealthy(); await unhealthy();
  assert.equal(f.events.filter(event => event.type === 'crash-loop').length, 1);
  const cleared = () => f.events.filter(event => event.type === 'crash-loop-cleared').length;

  // Running all the time, as it was before each restart: ten minutes, an hour of ticks clear nothing.
  for (let tick = 0; tick < 6; tick++) { await f.clock.advance(CRASH_LOOP_CLEAR_MS); f.watchdogTick(); }
  assert.equal(cleared(), 0, 'Running says nothing about an app that was restarted for not answering');
  // The one more round after ten minutes is still allowed, and counts again.
  await unhealthy();
  assert.equal(f.restarts.length, 4);
  // Healthy right after that restart: too early to call it recovered.
  f.reconciler.observeHealthy('memos');
  assert.equal(cleared(), 0);
  await f.clock.advance(CRASH_LOOP_CLEAR_MS);
  f.watchdogTick();
  assert.equal(cleared(), 0);
  // Healthy ten minutes after its last restart: recovered.
  f.reconciler.observeHealthy('other');
  assert.equal(cleared(), 0, 'another app\'s health is not this one\'s');
  f.reconciler.observeHealthy('memos');
  assert.deepEqual(f.events.at(-1), { type: 'crash-loop-cleared', container: 'app-memos' });

  // When the last automatic start was the watchdog's (the container had stopped), running ten minutes clears, as before.
  const g = box();
  const restart = async () => { g.reconciler.request('memos', 'restart', 'L3 failed'); await g.clock.advance(60_000); };
  await restart(); await restart();
  g.containers.set('app-memos', 'Stopped'); g.watchdogTick(); await g.clock.advance(60_000);
  assert.equal(g.events.filter(event => event.type === 'crash-loop').length, 1);
  await g.clock.advance(CRASH_LOOP_CLEAR_MS);
  g.watchdogTick();
  assert.deepEqual(g.events.at(-1), { type: 'crash-loop-cleared', container: 'app-memos' });
});

test('the prober reports every healthy probe to the queue', async () => {
  const f = box();
  const p = prober(f);
  let probing = p.probe();
  await f.clock.advance(0);
  assert.equal((await probing)[0].state, 'running');
  assert.equal(p.calls.healthy, 1);
  const failing = prober(f, { httpOk: false });
  probing = failing.probe();
  await f.clock.advance(0);
  assert.notEqual((await probing)[0].state, 'running');
  assert.equal(failing.calls.healthy, 0);
});

test('a restart is not lost when a background pass takes the app while its run is in flight', async () => {
  const f = box();
  f.world.readMs = 1_000;
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(500);          // the run reads the containers, lock-free: the request has left `pending`
  f.world.held = true;                 // the 30 s reconcile pass takes the app
  f.reconciler.operation('memos', 'begin', 'background');
  await f.clock.advance(1_000);        // the run finds the app busy and, cancelled, does not ask again
  assert.deepEqual(f.restarts, []);
  assert.equal(f.reconciler.pending('memos'), undefined);
  f.world.held = false;
  f.reconciler.operation('memos', 'end', 'background');
  assert.equal(f.reconciler.pending('memos'), 'restart', 'the pass\'s end asks for the restart again');
  await f.clock.advance(5_000);
  assert.equal(f.restarts.length, 1);
  assert.deepEqual(f.events.filter(event => event.type === 'restarted'), [{ type: 'restarted', appId: 'memos', reason: 'L3 failed' }]);

  // A user's operation still drops it for good: its end asks for a plain start.
  const g = box();
  g.world.readMs = 1_000;
  g.reconciler.request('memos', 'restart', 'L3 failed');
  await g.clock.advance(500);
  g.world.held = true;
  g.reconciler.operation('memos', 'begin', 'user');
  await g.clock.advance(1_000);
  g.world.held = false;
  g.reconciler.operation('memos', 'end', 'user');
  assert.equal(g.reconciler.pending('memos'), 'start');
  await g.clock.advance(5_000);
  assert.deepEqual(g.restarts, []);
});

test('a restart kept for a background pass is done once, also when the run in flight gets to do it', async () => {
  const f = box();
  f.world.readMs = 1_000;
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(500);
  // The pass begins and ends while the run still reads: the run then gets the lock and restarts the app itself.
  f.world.held = true;
  f.reconciler.operation('memos', 'begin', 'background');
  f.world.held = false;
  f.reconciler.operation('memos', 'end', 'background');
  await f.clock.advance(60_000);
  assert.equal(f.restarts.length, 1, 'not restarted a second time for the request asked again at the pass\'s end');
  assert.equal(f.reconciler.pending('memos'), undefined);
});

test('a background pass that takes the app after the run let it go, but before the run ended, does not restart it again', async () => {
  const f = box();
  f.world.afterLock = () => {
    f.world.afterLock = undefined;
    // The run has restarted the app and let go of its lock; the 30 s reconcile pass takes the app before the run's
    // own end. It keeps the restart in flight, which the run has already done.
    f.world.held = true;
    f.reconciler.operation('memos', 'begin', 'background');
  };
  f.reconciler.request('memos', 'restart', 'L3 failed');
  await f.clock.advance(1_000);
  assert.equal(f.restarts.length, 1);
  f.world.held = false;
  f.reconciler.operation('memos', 'end', 'background');
  assert.equal(f.reconciler.pending('memos'), 'start', 'the pass\'s end asks for a plain start, not the restart again');
  await f.clock.advance(60_000);
  assert.equal(f.restarts.length, 1, 'restarted once');
});

test('the crash-loop record and its issue do not outlive an uninstall', async () => {
  const f = box();
  const crash = async () => { f.containers.set('app-memos', 'Stopped'); f.watchdogTick(); await f.clock.advance(60_000); };
  await crash(); await crash(); await crash();
  assert.equal(f.events.filter(event => event.type === 'crash-loop').length, 1);
  // Still installed: the watchdog's list of owned containers changes nothing.
  f.reconciler.retainContainers(new Set(['app-memos-db', 'app-memos']));
  assert.equal(f.events.filter(event => event.type === 'crash-loop-cleared').length, 0);
  // Uninstalled: no install record owns app-memos any more.
  f.reconciler.retainContainers(new Set(['app-other']));
  assert.deepEqual(f.events.filter(event => event.type === 'crash-loop-cleared'),
    [{ type: 'crash-loop-cleared', container: 'app-memos' }]);
  // Installed again under the same name: a fresh count.
  await crash();
  assert.equal(f.starts.length, 4, 'not paused by the old record');
});

test('a paused container gets one more round ten minutes after its last start', async () => {
  const f = box();
  const crash = async () => { f.containers.set('app-memos', 'Stopped'); f.watchdogTick(); await f.clock.advance(60_000); };
  await crash(); await crash(); await crash(); await crash();
  assert.equal(f.starts.length, 3);
  await f.clock.advance(CRASH_LOOP_CLEAR_MS);
  f.watchdogTick();
  await f.clock.advance(0);
  assert.equal(f.starts.length, 4);
  assert.equal(f.events.filter(event => event.type === 'crash-loop-cleared').length, 0, 'the issue stays until it has run');
  await f.clock.advance(CRASH_LOOP_CLEAR_MS);
  f.watchdogTick();
  assert.equal(f.events.filter(event => event.type === 'crash-loop-cleared').length, 1);
});

// ─── The held marker and the operation listener (real admission) ───

test('withAppLifecycle marks the app held, announces its begin and end, and stays silent for the queue itself', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-reconciler-'));
  const store = new AppUpdateJournalStore(path.join(root, 'journal'));
  const heard: string[] = [];
  setAppOperationListener((appId, phase, origin) => heard.push(`${appId}:${phase}:${isAppHeld(appId) ? 'held' : 'free'}:${origin}`));
  try {
    assert.equal(isAppHeld('fixture'), false);
    await withAppLifecycle('fixture', async () => {
      assert.equal(isAppHeld('fixture'), true);
      assert.equal(isAppHeldByCaller('fixture', store), true);
      assert.equal(isAppHeld('other'), false);
      // A nested entry of the same operation announces nothing.
      await withAppLifecycle('fixture', () => undefined, { store });
      // Another caller sees the hold, and that it is not its own.
      await new Promise<void>(resolve => setImmediate(() => {
        assert.equal(isAppHeld('fixture'), true);
        resolve();
      }));
    }, { store });
    assert.equal(isAppHeld('fixture'), false);
    assert.equal(isAppHeldByCaller('fixture', store), false);
    // The end is announced after the release, so the re-check can take the lock.
    assert.deepEqual(heard, ['fixture:begin:held:background', 'fixture:end:free:background']);

    await withAppLifecycle('fixture', () => { assert.equal(isAppHeld('fixture'), true); }, { store, automatic: true });
    assert.equal(heard.length, 2, "the queue's own hold is not an operation");

    await assert.rejects(withAppLifecycle('fixture', () => { throw new Error('failed operation'); }, { store }), /failed operation/);
    assert.deepEqual(heard.slice(2), ['fixture:begin:held:background', 'fixture:end:free:background'], 'a failed operation ends too');

    // A user's request is told apart from a background pass.
    await withUserOperationLockWait(() => withAppLifecycle('fixture', () => undefined, { store }));
    assert.deepEqual(heard.slice(4), ['fixture:begin:held:user', 'fixture:end:free:user']);
  } finally {
    setAppOperationListener(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the queue's work is nobody's operation: no user wait, no abort signal, no inherited admission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-reconciler-'));
  const store = new AppUpdateJournalStore(path.join(root, 'journal'));
  const abort = new AbortController();
  let external: AppUpdateExecutorLock | undefined;
  let waitedMs = -1, countedAsUser = false, error: Error | undefined, insideCore: boolean | undefined;
  const coreLock = () => {
    // A System writer can take the platform exclusively only when nobody holds a core admission.
    try { AppUpdateExecutorLock.acquire(path.join(store.directory, 'core-lifecycle.flock')).release(); return false; }
    catch { return true; }
  };
  try {
    const attempted = new Promise<void>(resolve => {
      const reconciler = createAppReconciler({
        now: () => Date.now(), random: () => 0,
        setTimer: (run, delayMs) => setTimeout(run, delayMs), clearTimer: timer => clearTimeout(timer as NodeJS.Timeout),
        isHeld: isAppHeld, isUserWaiting: isUserOperationWaiting,
        async withAppLock(appId, work) {
          const began = Date.now();
          const watch = setInterval(() => { countedAsUser ||= isUserOperationWaiting(appId); }, 20);
          try { return await withAppLifecycle(appId, work, { store, automatic: true }); }
          catch (caught) { error = caught as Error; throw caught; }
          finally { clearInterval(watch); waitedMs = Date.now() - began; resolve(); }
        },
        stoppedContainers: async () => { insideCore = coreLock(); return ['app-fixture']; },
        startContainer: async () => true, restartApp: async () => ({ started: [] }),
        report() {},
      });
      setAppOperationListener((appId, phase) => {
        // Another process takes the app right after the user's operation ends.
        if (phase === 'end') external = AppUpdateExecutorLock.acquire(path.join(store.directory, 'executors', `app-${appId}.lock`));
        reconciler.operation(appId, phase);
      });
    });
    // The user's operation, inside an outer core admission, announces its end: the queue's timer is created here.
    await withUserOperationLockWait(
      () => withPlatformLifecycle(() => withAppLifecycle('fixture', () => undefined, { store }), store.directory),
      { timeoutMs: 2_000, signal: abort.signal });
    abort.abort(); // the user's request is over
    await attempted;
    assert.equal(error?.name, 'AppUpdateExecutorLockBusyError', 'a busy lock fails at once, neither waited for nor cancelled');
    assert.ok(waitedMs < 500, `the queue waited ${waitedMs} ms for the lock like a user`);
    assert.equal(countedAsUser, false, 'the queue never counts as a waiting user');
    assert.equal(insideCore, false, "the queue does not run inside the ended operation's core admission");
  } finally {
    external?.release();
    setAppOperationListener(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Timers ───

test('jittered timers: first run after 60–90 s, then every period ±15 %, and two loops drift apart', (t) => {
  assert.deepEqual(FIRST_DELAY_MS, [60_000, 90_000]);
  assert.equal(jitteredDelay(30_000, 0.15, 0), 25_500);
  assert.equal(jitteredDelay(30_000, 0.15, 1), 34_500);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runs: number[] = [];
  let elapsed = 0;
  const randoms = [0, 1, 0, 0.5];
  const stop = startJitteredLoop(() => runs.push(elapsed), { periodMs: 60_000, random: () => randoms.shift() ?? 0.5 });
  const tick = (ms: number) => { elapsed += ms; t.mock.timers.tick(ms); };
  tick(59_999); assert.deepEqual(runs, []);
  tick(1); assert.deepEqual(runs, [60_000]);
  tick(69_000); assert.deepEqual(runs, [60_000, 129_000]);
  tick(51_000); assert.deepEqual(runs, [60_000, 129_000, 180_000]);
  stop();
  tick(600_000); assert.equal(runs.length, 3);
});

test('a crash loop says what happens next: automatic starts paused, one more try in 10 minutes', () => {
  for (const file of ['src/lib/apps/app-reconciler.ts', 'src/lib/health/monitor.ts']) {
    const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /Auto-start paused|Auto-restart stopped/, file);
    assert.match(source, /are paused; one more try 10 minutes after the last (start|restart)/, file);
  }
  assert.equal(CRASH_LOOP_CLEAR_MS, 10 * 60_000);
});
