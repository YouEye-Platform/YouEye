import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { containerOrder, loadSource } from './fixtures/update-provider-harness';

const immich = () => ({
  appId: 'immich', enabled: true, desiredState: 'running', storageVolumes: [],
  containers: [
    { name: 'main', containerName: 'app-immich-main', type: 'oci', primary: true },
    { name: 'postgres', containerName: 'app-immich-postgres', type: 'oci', role: 'database' },
    { name: 'valkey', containerName: 'app-immich-valkey', type: 'oci' },
    { name: 'ml', containerName: 'app-immich-ml', type: 'oci' },
  ],
});
const manifest = {
  database: { mode: 'own', container: 'postgres', user: 'immich' },
  containers: [
    { name: 'main', port: 2283, healthCheck: { type: 'http', path: '/api/server/ping', timeout: 90_000 } },
    { name: 'postgres', healthCheck: { type: 'postgres', user: 'immich', timeout: 60_000 } },
    { name: 'valkey' },
    { name: 'ml' },
  ],
};

/** The real reconciler module; Incus and readiness are a log. */
function load(states: Map<string, string>, config: Record<string, Record<string, string>> = {},
  hooks: { started?(name: string): void; restart?(name: string): void } = {}) {
  const events: string[] = [];
  const code = ts.transpileModule(readFileSync(path.join(import.meta.dirname, '../src/lib/apps/app-reconciler.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api: any = {};
  const modules: Record<string, unknown> = {
    './container-order': containerOrder(),
    './container-readiness': loadSource('lib/apps/container-readiness.ts', () => ({})),
    '../market/metadata': { readInstallMetadata: async () => immich(), listInstalledApps: async () => [immich()] },
    '../market/frozen-manifest': { readFrozenUpdateManifest: async () => manifest },
    '../market/health': {
      waitForPostgresHealth: async (name: string, user: string, _timeoutMs: number, giveUp?: () => boolean) => {
        events.push(`pg_isready:${name}:${user}${giveUp ? '' : ':cannot-yield'}`); return true;
      },
      waitForAppHealth: async (name: string) => { events.push(`health:${name}`); return true; },
    },
    '../market/storage': { inspectAppStorage: async () => ({ available: true }) },
    '../maintenance/container-maintenance': { isContainerMaintenanceActive: () => false },
    // The lock is the queue's; here every lifecycle entry is let through and counted.
    '../market/update-admission': {
      withContainerLifecycle: async (name: string, work: () => unknown, options: { automatic?: boolean }) => {
        events.push(`admitted:${name}${options?.automatic ? '' : ':as-an-operation'}`);
        return work();
      },
    },
    '../incus/server': {
      async incusRequest(method: string, route: string, body?: { action: string }) {
        const name = decodeURIComponent(route.split('/')[3]);
        if (method === 'GET') return { type: 'sync', metadata: { status: states.get(name), config: config[name] ?? {} } };
        events.push(`${body!.action}:${name}`);
        states.set(name, 'Running');
        hooks.started?.(name);
        return { type: 'sync' };
      },
    },
    '../infrastructure/oci-deployer': { waitForIncusOperation: async () => {} },
    '../infrastructure/resource-policy': { applyResourcePolicy: async () => {} },
    '../incus/snapshot': {
      containerState: async (name: string) => states.get(name) ?? 'Unknown',
      restartContainer: async (name: string, options: { timeoutSec: number }) => {
        events.push(`restart:${name}:${options.timeoutSec}`);
        hooks.restart?.(name);
      },
      stopTimeoutSec: (role?: string) => role === 'database' ? 120 : 60,
    },
  };
  runInNewContext(code, { exports: api, console, encodeURIComponent, require: (id: string) => modules[id] ?? {} });
  const effects = () => events.filter(event => !event.startsWith('admitted:'));
  return { api, events, effects };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('the reconcile queue starts an app in the update order: database, cache, sidecar, app last', () => {
  const { api } = load(new Map());
  assert.deepEqual([...api.startOrder(immich()).map((c: { name: string }) => c.name)],
    ['app-immich-postgres', 'app-immich-valkey', 'app-immich-ml', 'app-immich-main']);
});

test('an automatic restart starts the stopped dependencies, the database ready first, then restarts main cleanly', async () => {
  const states = new Map([
    ['app-immich-main', 'Running'], ['app-immich-postgres', 'Stopped'], ['app-immich-valkey', 'Running'], ['app-immich-ml', 'Stopped'],
  ]);
  const { api, events, effects } = load(states);
  assert.deepEqual(plain(await api.restartApp('immich')),
    { started: ['app-immich-postgres', 'app-immich-ml'], restarted: 'app-immich-main' });
  assert.deepEqual(effects(), [
    'start:app-immich-postgres', 'pg_isready:app-immich-postgres:immich',
    'start:app-immich-ml',
    'restart:app-immich-main:20',
  ]);
  // Every start and the restart pass the container's admission (reservation, recovery copies) as the queue itself.
  assert.deepEqual(events.filter(event => event.startsWith('admitted:')),
    ['admitted:app-immich-postgres', 'admitted:app-immich-ml', 'admitted:app-immich-main']);
});

test('an automatic restart starts a main container that is not running instead of restarting it', async () => {
  const states = new Map([
    ['app-immich-main', 'Stopped'], ['app-immich-postgres', 'Running'], ['app-immich-valkey', 'Running'], ['app-immich-ml', 'Running'],
  ]);
  const { api, effects } = load(states);
  assert.deepEqual(plain(await api.restartApp('immich')), { started: [], restarted: 'app-immich-main' });
  assert.deepEqual(effects(), ['start:app-immich-main']);
});

test('an automatic restart reads the main container again after its dependencies: one that stopped meanwhile is started', async () => {
  const states = new Map([
    ['app-immich-main', 'Running'], ['app-immich-postgres', 'Stopped'], ['app-immich-valkey', 'Running'], ['app-immich-ml', 'Running'],
  ]);
  // The main container exits while its database is started and waited for.
  const { api, effects } = load(states, {}, { started: name => { if (name === 'app-immich-postgres') states.set('app-immich-main', 'Stopped'); } });
  assert.deepEqual(plain(await api.restartApp('immich')), { started: ['app-immich-postgres'], restarted: 'app-immich-main' });
  assert.deepEqual(effects(), ['start:app-immich-postgres', 'pg_isready:app-immich-postgres:immich', 'start:app-immich-main']);

  // ... or the owner's fence (autostart off) arrived meanwhile: it is left alone.
  const fenced = new Map(states).set('app-immich-main', 'Running').set('app-immich-postgres', 'Stopped');
  const config: Record<string, Record<string, string>> = {};
  const g = load(fenced, config, { started: () => { config['app-immich-main'] = { 'boot.autostart': 'false' }; } });
  assert.deepEqual(plain(await g.api.restartApp('immich')), { started: ['app-immich-postgres'] });
  assert.deepEqual(g.effects(), ['start:app-immich-postgres', 'pg_isready:app-immich-postgres:immich']);
});

test('an automatic restart that fails reports the dependencies it had started', async () => {
  const states = () => new Map([
    ['app-immich-main', 'Running'], ['app-immich-postgres', 'Stopped'], ['app-immich-valkey', 'Running'], ['app-immich-ml', 'Running'],
  ]);
  const refuse = () => { throw new Error('Container app-immich-main could not start after its stop'); };
  const result = await load(states(), {}, { restart: refuse }).api.restartApp('immich');
  assert.deepEqual(plain(result.started), ['app-immich-postgres']);
  assert.equal(result.restarted, undefined);
  assert.match(result.failure.message, /could not start after its stop/);
  // With nothing started there is nothing to count: the failure is thrown as before.
  await assert.rejects(load(states().set('app-immich-postgres', 'Running'), {}, { restart: refuse }).api.restartApp('immich'),
    /could not start after its stop/);
});

test('an automatic restart honours the crash-loop pause and boot.autostart=false', async () => {
  const running = () => new Map([
    ['app-immich-main', 'Running'], ['app-immich-postgres', 'Stopped'], ['app-immich-valkey', 'Running'], ['app-immich-ml', 'Running'],
  ]);
  const never = () => false;
  // The main container is paused by a crash loop: nothing happens, not even to its dependencies.
  let f = load(running());
  assert.deepEqual(plain(await f.api.restartApp('immich', { paused: (name: string) => name === 'app-immich-main', yieldNow: never })),
    { started: [] });
  assert.deepEqual(f.effects(), []);
  // The main container has autostart off (the owner's stop, an update's fence): left alone.
  f = load(running(), { 'app-immich-main': { 'boot.autostart': 'false' } });
  assert.deepEqual(plain(await f.api.restartApp('immich')), { started: [] });
  assert.deepEqual(f.effects(), []);
  // A stopped database in a crash loop stays stopped, and main is not restarted against it.
  f = load(running());
  assert.deepEqual(plain(await f.api.restartApp('immich', { paused: (name: string) => name === 'app-immich-postgres', yieldNow: never })),
    { started: [] });
  assert.deepEqual(f.effects(), []);
  // A stopped dependency with autostart off is not started; the main container still is restarted.
  f = load(running(), { 'app-immich-postgres': { 'boot.autostart': 'false' } });
  assert.deepEqual(plain(await f.api.restartApp('immich')), { started: [], restarted: 'app-immich-main' });
  assert.deepEqual(f.effects(), ['restart:app-immich-main:20']);
});

test('an automatic restart gives way to a waiting user: the readiness wait can end early and main is not stopped', async () => {
  const states = new Map([
    ['app-immich-main', 'Running'], ['app-immich-postgres', 'Stopped'], ['app-immich-valkey', 'Running'], ['app-immich-ml', 'Stopped'],
  ]);
  const { api, effects } = load(states);
  let userWaiting = false;
  const result = await api.restartApp('immich', {
    paused: () => false,
    // The user arrives while the database gets ready.
    yieldNow: () => userWaiting || (effects().some(event => event.startsWith('pg_isready')) && (userWaiting = true)),
  });
  assert.deepEqual(plain(result), { started: ['app-immich-postgres'], yielded: true });
  assert.deepEqual(effects(), ['start:app-immich-postgres', 'pg_isready:app-immich-postgres:immich'],
    'the readiness wait was given the way out; nothing was started or stopped after the user arrived');
});

test('an install starts containers in the same order: database, cache, sidecar, worker, main last', async () => {
  const { installStartOrder } = await import('../src/lib/market/engine');
  const spec = (name: string, primary = false) => ({ name, type: 'oci', primary });
  const order = installStartOrder({
    metadata: { id: 'paperless' }, database: { mode: 'own', container: 'store' },
    // Declared out of order on purpose: a worker and a sidecar before the database and the cache.
    containers: [spec('worker'), spec('tika'), spec('store'), spec('valkey'), spec('main', true)],
  } as any).map((c: { name: string }) => c.name);
  assert.deepEqual(order, ['store', 'valkey', 'tika', 'worker', 'main']);
  // A single-container app: just main.
  assert.deepEqual(installStartOrder({ metadata: { id: 'memos' }, containers: [spec('main', true)] } as any)
    .map((c: { name: string }) => c.name), ['main']);
});

test('a readiness wait ends at once, without a timeout warning, when its caller has to give the app back', async (t) => {
  let probes = 0, slept = 0, userWaiting = false;
  const warn = t.mock.method(console, 'warn', () => {});
  const health = loadSource('lib/market/health.ts', (name) => name === '../incus/server'
    ? { execCommand: async () => { probes += 1; if (probes === 2) userWaiting = true; return { exitCode: 2 }; } }
    : { getContainerIP: async () => { probes += 1; if (probes === 4) userWaiting = true; return null; } },
  { setTimeout: (run: () => void, ms: number) => { slept += ms; setImmediate(run); } });
  assert.equal(await health.waitForPostgresHealth('app-x-db', 'x', 60_000, () => userWaiting), false);
  assert.equal(probes, 2);
  assert.equal(slept, 4_000, 'two polls, not the minute');
  assert.equal(warn.mock.callCount(), 0);
  userWaiting = false;
  assert.equal(await health.waitForAppHealth('app-x-cache', 6379, '/', 60_000, () => userWaiting), false);
  assert.equal(probes, 4);
});
