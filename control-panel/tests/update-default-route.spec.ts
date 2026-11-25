// YE-220: an app operation's own container starts (an update's first start, a rollback's restore, a recovery's
// reopen) get the route repair right after the start and before any health or readiness wait. The operation holds the
// app, so the route guard's event-driven repair waits for the hold to end: a connected app whose start needs the
// internet (Bazarr with Sonarr and Radarr) failed its health on the connection NIC's default route and rolled back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { containerOrder, loadSource } from './fixtures/update-provider-harness';

function fixture(options: { guardFails?: boolean; withDatabase?: boolean } = {}) {
  const app = 'app-bazarr';
  const db = 'app-bazarr-db';
  const containers = [
    ...(options.withDatabase ? [{ name: 'db', containerName: db, type: 'oci', role: 'database' }] : []),
    { name: 'main', containerName: app, type: 'oci', primary: true },
  ];
  const states = new Map(containers.map(c => [c.containerName, 'Stopped']));
  const events: string[] = [];
  const warnings: string[] = [];
  const plan = {
    metadata: { appId: 'bazarr', installedVersion: '1.6.2.373', containers },
    manifest: { containers: containers.map(c => ({ name: c.name })) },
    instances: containers.map(c => ({ name: c.containerName, config: { 'volatile.base_image': 'image' } })),
  };
  const exports = loadSource('lib/market/update-provider.ts', (module: string) => {
    if (module === '@/lib/apps/container-order') return containerOrder();
    if (module === '@/lib/apps/container-readiness') return loadSource('lib/apps/container-readiness.ts', () => ({}));
    if (module === '@/lib/incus/snapshot') return {
      containerState: async (name: string) => states.get(name),
      startContainer: async (name: string) => { events.push(`start:${name}`); states.set(name, 'Running'); },
      stopContainer: async () => undefined,
      stopTimeoutSec: () => 60,
      waitForRunning: async (name: string) => { assert.equal(states.get(name), 'Running'); },
      waitForContainerExec: async (name: string) => { events.push(`exec-ready:${name}`); return { shell: true }; },
    };
    if (module === '@/lib/incus/server') return {
      incusRequest: async (_method: string, url: string) => ({ type: 'sync', metadata: { name: url.split('/').pop(), config: { 'volatile.base_image': 'image' } } }),
    };
    if (module === '@/lib/incus/default-route-watch') return {
      defaultRouteGuard: async () => ({
        repairAfterOperationStart: async (name: string, reason: string) => {
          if (options.guardFails) throw new Error('Incus answered nothing');
          assert.equal(states.get(name), 'Running', 'the repair runs on the started container');
          events.push(`route:${name}:${reason}`);
          return 'repaired';
        },
      }),
    };
    if (module === './metadata') return { readInstallMetadata: async () => ({ installedVersion: '1.6.2.373' }) };
    if (module === './frozen-manifest') return { readFrozenUpdateManifest: async () => plan.manifest };
    return {};
  }, { console: { ...console, warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) } });
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => plan;
  provider.noProviderEffects = () => false;
  provider.postgres = async () => undefined;
  provider.optionalFence = () => undefined;
  provider.bootFence = async () => undefined;
  provider.ingress = async () => undefined;
  provider.stopTimeout = () => 60;
  // The readiness and health check: never before the route repair of the same container.
  provider.waitReady = async (_plan: unknown, name: string) => { events.push(`ready:${name}`); };
  const record = {
    appId: 'bazarr', id: 'op', phase: 'applying', steps: [], commit: { receipt: 'committed' },
    originalRunning: Object.fromEntries(containers.map(c => [c.containerName, true])),
  };
  return { provider, record, events, warnings, app, db };
}

test('update: the first start of a connected app repairs its default route before anything waits on it', async () => {
  const f = fixture({ withDatabase: true });
  await f.provider.startRuntime(f.record, f.db);
  await f.provider.startRuntime(f.record, f.app);
  assert.deepEqual(f.events, [
    'start:app-bazarr-db', 'exec-ready:app-bazarr-db', 'route:app-bazarr-db:app update start', 'ready:app-bazarr-db',
    'start:app-bazarr', 'exec-ready:app-bazarr', 'route:app-bazarr:app update start',
  ]);
});

test('rollback: each restored container is repaired after its start and before its health check', async () => {
  const f = fixture({ withDatabase: true });
  await f.provider.verifyRestored(f.record);
  assert.deepEqual(f.events, [
    'start:app-bazarr-db', 'exec-ready:app-bazarr-db', 'route:app-bazarr-db:app rollback start', 'ready:app-bazarr-db',
    'start:app-bazarr', 'exec-ready:app-bazarr', 'route:app-bazarr:app rollback start', 'ready:app-bazarr',
  ]);
});

test('recovery: reopening after a commit starts each container through the same repair', async () => {
  const f = fixture();
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, ['start:app-bazarr', 'exec-ready:app-bazarr', 'route:app-bazarr:app update start']);
});

test('a route repair that fails never fails the update: it is logged and the health check decides', async () => {
  const failing = fixture({ guardFails: true });
  await failing.provider.startRuntime(failing.record, failing.app);
  await failing.provider.verifyRestored(failing.record);
  assert.deepEqual(failing.events, ['start:app-bazarr', 'exec-ready:app-bazarr', 'exec-ready:app-bazarr', 'ready:app-bazarr']);
  assert.equal(failing.warnings.length, 2);
  assert.match(failing.warnings[0], /default route check of app-bazarr failed: Incus answered nothing/);
});
