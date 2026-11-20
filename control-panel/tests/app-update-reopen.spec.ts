import assert from 'node:assert/strict';
import test from 'node:test';
import { containerOrder, loadSource } from './fixtures/update-provider-harness';

function fixture(mode: 'own' | 'shared' = 'own', desired = true, healthy = true) {
  const engine = mode === 'own' ? 'app-fixture-db' : 'youeye-postgres';
  const states = new Map([['app-fixture-main', 'Stopped'], [engine, 'Stopped']]);
  const events: string[] = [];
  const plan = {
    metadata: { appId: 'fixture', containers: [
      { name: 'main', containerName: 'app-fixture-main', type: 'oci', primary: true },
      ...(mode === 'own' ? [{ name: 'db', containerName: engine, type: 'oci', role: 'database' }] : []),
    ] },
    manifest: {
      database: mode === 'own' ? { mode, container: 'db', name: 'fixture', user: 'fixture' } : { mode, name: 'fixture', user: 'fixture' },
      containers: [{ name: 'main' }, ...(mode === 'own' ? [{ name: 'db' }] : [])],
    },
  };
  /** What the app's registration holds after the commit; a test replaces it with the new version's manifest. */
  const installed: { manifest?: typeof plan.manifest } = { manifest: plan.manifest };
  const record: { appId: string; phase: string; commit?: unknown; rollbackVerifiedAt?: string; steps: unknown[]; originalRunning: Record<string, boolean> } = {
    appId: 'fixture', phase: 'cleanup', commit: { receipt: 'committed' },
    steps: [{ phase: 'applying' }],
    originalRunning: {
      'app-fixture-main': desired,
      ...(mode === 'own' ? { [engine]: desired } : {}),
    },
  };
  const exports = loadSource('lib/market/update-provider.ts', (name: string) => {
    if (name === '@/lib/apps/container-order') return containerOrder();
    if (name === '@/lib/apps/container-readiness') return loadSource('lib/apps/container-readiness.ts', () => ({}));
    if (name === '@/lib/incus/snapshot') return {
      containerState: async (name: string) => states.get(name),
      startContainer: async (name: string) => { events.push(`start:${name}`); states.set(name, 'Running'); },
      stopContainer: async (name: string) => {
        if (states.get(name) !== 'Running') return;
        events.push(`stop:${name}`);
        states.set(name, 'Stopped');
      },
      stopTimeoutSec: () => 60,
      waitForRunning: async (name: string) => { assert.equal(states.get(name), 'Running'); },
      waitForContainerExec: async () => {},
    };
    if (name === './health') return {
      waitForPostgresHealth: async (name: string, user: string) => {
        events.push(`ready:${name}:${user}`);
        assert.equal(name, engine);
        assert.equal(states.get(engine), 'Running');
        return healthy;
      },
    };
    if (name === './frozen-manifest') return {
      readFrozenUpdateManifest: async (appId: string) => {
        assert.equal(appId, 'fixture');
        if (!installed.manifest) throw new Error('frozen copy unreadable');
        return installed.manifest;
      },
    };
    return {};
  });
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => plan;
  provider.optionalFence = () => ({ operationId: 'fixture' });
  // Only a database in the shared platform PostgreSQL has a logical provider and a fence.
  provider.postgres = async () => mode === 'own' ? undefined : ({
    unfence: async (_fence: unknown, phase: string) => {
      events.push(`unfence:${phase}`);
      assert.equal(states.get(engine), 'Running', 'Cannot reconcile a stopped database');
      assert.equal(states.get('app-fixture-main'), 'Stopped', 'Writers must remain stopped');
    },
  });
  provider.bootFence = async (_record: unknown, fenced: boolean) => {
    events.push(fenced ? 'verify-boot-fence' : 'release-boot-fence');
  };
  provider.ingress = async () => { events.push('release-ingress'); };
  return { provider, record, states, events, engine, plan, installed };
}

test('committed cleanup after reboot starts the app-owned database, waits for it as the app user, then starts the app', async () => {
  const f = fixture();
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, [
    'verify-boot-fence', 'start:app-fixture-db', 'ready:app-fixture-db:fixture',
    'start:app-fixture-main', 'release-boot-fence', 'release-ingress',
  ]);
  assert.equal(f.states.get(f.engine), 'Running');
});

test('a reopen after a commit checks readiness as the installed (new) manifest declares it; after a rollback, as the old one', async (t) => {
  const renamed = (f: ReturnType<typeof fixture>) => ({ ...f.plan.manifest, database: { ...f.plan.manifest.database, user: 'fixture_v2' } });
  // Committed: the new version runs, and its database answers as the new manifest's user.
  let f = fixture();
  f.installed.manifest = renamed(f);
  await f.provider.reopen(f.record);
  assert.ok(f.events.includes('ready:app-fixture-db:fixture_v2'));
  assert.ok(!f.events.includes('ready:app-fixture-db:fixture'));

  // Rolled back: the old version was restored; the plan's manifest describes it.
  f = fixture();
  f.installed.manifest = renamed(f);
  f.record.commit = undefined;
  f.record.rollbackVerifiedAt = 'now';
  await f.provider.reopen(f.record);
  assert.ok(f.events.includes('ready:app-fixture-db:fixture'));

  // The installed copy cannot be read: the reopen is not held up, readiness is checked as before, and it is logged.
  f = fixture();
  f.installed.manifest = undefined;
  const warn = t.mock.method(console, 'warn', () => {});
  await f.provider.reopen(f.record);
  assert.ok(f.events.includes('ready:app-fixture-db:fixture'));
  assert.equal(warn.mock.callCount(), 1);
});

test('an app that was stopped before the update is stopped again, the app before its database', async () => {
  const f = fixture('own', false);
  f.states.set('app-fixture-main', 'Running');
  f.states.set(f.engine, 'Running');
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, [
    'verify-boot-fence', 'stop:app-fixture-main', 'stop:app-fixture-db', 'release-boot-fence', 'release-ingress',
  ]);
});

test('database readiness failure preserves writer and traffic fences for later committed cleanup', async () => {
  const f = fixture('own', true, false);
  await assert.rejects(f.provider.reopen(f.record), /did not accept database connections/);
  assert.deepEqual(f.events, ['verify-boot-fence', 'start:app-fixture-db', 'ready:app-fixture-db:fixture']);
  assert.equal(f.states.get('app-fixture-main'), 'Stopped');
});

test('a shared-database app has its grants restored with its containers stopped, then starts', async () => {
  const f = fixture('shared');
  f.states.set(f.engine, 'Running');
  f.states.set('app-fixture-main', 'Running');
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, [
    'verify-boot-fence', 'stop:app-fixture-main', 'unfence:original', 'start:app-fixture-main',
    'release-boot-fence', 'release-ingress',
  ]);
});

test('app recovery never starts a stopped shared platform database', async () => {
  const f = fixture('shared');
  await assert.rejects(f.provider.reopen(f.record), /stopped database/);
  assert.deepEqual(f.events, ['verify-boot-fence', 'unfence:original']);
  assert.equal(f.states.get(f.engine), 'Stopped');
});

test('changed runtime identity is refused before starting the app-owned database', async () => {
  const f = fixture();
  f.provider.bootFence = async () => { throw new Error('App runtime identity changed outside the update'); };
  await assert.rejects(f.provider.reopen(f.record), /identity changed/);
  assert.deepEqual(f.events, []);
  assert.equal(f.states.get(f.engine), 'Stopped');
});
