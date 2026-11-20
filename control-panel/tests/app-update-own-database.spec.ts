import assert from 'node:assert/strict';
import test from 'node:test';
import { ownDatabaseApp } from './fixtures/update-provider-app';

const preflight = (code: string) => (error: any) => error?.name === 'AppUpdatePreflightError' && error.code === code;

test("an app's own database is checkpointed like any volume, with every container stopped", async () => {
  const f = ownDatabaseApp();
  await f.prepare();
  // Stops first (database last), then copies and snapshots. Nothing is started, no database is asked anything.
  const firstCheckpoint = f.events.findIndex(e => e.startsWith('copy:') || e.startsWith('snapshot:'));
  assert.deepEqual(f.events.slice(0, firstCheckpoint), [
    'stop:app-fixture-main:60', 'stop:app-fixture-worker:60', 'stop:app-fixture-valkey:60', 'stop:app-fixture-postgres:120',
  ]);
  assert.ok(f.events.slice(firstCheckpoint).every(e => e.startsWith('copy:') || e.startsWith('snapshot:')));
  assert.ok(f.events.includes('snapshot:ye-fixture-postgres-data'));
  assert.ok(f.events.some(e => e.startsWith('copy:app-fixture-postgres>')));
  for (const name of f.containers) assert.equal(f.incus.instances.get(name)!.status, 'Stopped');
  assert.deepEqual(f.record.checkpoints.map(c => c.method).sort(), [
    'runtime-copy', 'runtime-copy', 'runtime-copy', 'runtime-copy', 'scoped-metadata', 'volume-snapshot', 'volume-snapshot',
  ]);
});

test('a rollback whose MAC address write is refused still restores the app, with a warning', async (t) => {
  const f = ownDatabaseApp();
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  await f.prepare();
  f.apply();
  f.record.phase = 'recovering';
  // Incus refuses the write that only sets the original MAC addresses (and nothing else).
  let refusals = 0;
  f.incus.faults.put = (name, body) => !name.startsWith('ye-rollback-') && !!body.config?.['volatile.eth0.hwaddr']
    && f.incus.instances.get(name)!.config['volatile.eth0.hwaddr'] !== body.config['volatile.eth0.hwaddr'] && ++refusals > 0;
  await f.provider.restore(f.record);
  assert.equal(refusals, f.containers.length);
  assert.equal(f.incus.volumes.get('ye-fixture-postgres-data')!.data, 'rows-1');
  for (const name of f.containers) {
    assert.equal(f.incus.instances.get(name)!.config['volatile.base_image'], `image-${name}`);
    assert.ok(warnings.some(w => w.includes(`the MAC addresses of restored ${name} could not be written`)));
    assert.ok(warnings.some(w => w.includes(`restored ${name} did not keep its MAC addresses`)));
  }
  await f.provider.verifyRestored(f.record);
  assert.ok(f.containers.every(name => f.incus.instances.get(name)!.status === 'Running'));
});

test('a failed update restores the volumes and the old containers together, then starts the database first', async () => {
  const f = ownDatabaseApp();
  const addresses = Object.fromEntries(f.containers.map(name => [name, f.incus.instances.get(name)!.config['volatile.eth0.hwaddr']]));
  await f.prepare();
  f.apply();
  f.events.length = 0;
  f.record.phase = 'recovering';
  await f.provider.restore(f.record);
  // Clean stops in stop order before anything is restored.
  assert.deepEqual(f.events.slice(0, 4), [
    'stop:app-fixture-main:60', 'stop:app-fixture-worker:60', 'stop:app-fixture-valkey:60', 'stop:app-fixture-postgres:120',
  ]);
  assert.ok(f.events.every(e => !e.startsWith('kill:')));
  assert.equal(f.incus.volumes.get('ye-fixture-main-data')!.data, 'photos-1');
  assert.equal(f.incus.volumes.get('ye-fixture-postgres-data')!.data, 'rows-1');
  for (const name of f.containers) {
    const restored = f.incus.instances.get(name)!;
    assert.equal(restored.config['volatile.base_image'], `image-${name}`);
    assert.equal(restored.config['user.youeye.update_restored'], f.record.id);
    // The swapped-in copy keeps the original MAC address, and with it its address on the app network.
    assert.equal(restored.config['volatile.eth0.hwaddr'], addresses[name]);
    assert.deepEqual(restored.devices, f.plan.instances.find(i => i.name === name)!.devices);
    assert.equal(restored.status, 'Stopped');
  }

  f.events.length = 0;
  await f.provider.verifyRestored(f.record);
  // Start order; the database answers pg_isready as the app's user before the cache, the worker and the app start.
  assert.deepEqual(f.events, [
    'start:app-fixture-postgres', 'pg_isready:app-fixture-postgres:fixture',
    'start:app-fixture-valkey', 'start:app-fixture-worker',
    'start:app-fixture-main', 'health:app-fixture-main',
  ]);
  f.events.length = 0;
  f.record.rollbackVerifiedAt = 'now';
  await f.provider.reopen(f.record);
  assert.ok(f.events.every(e => !e.startsWith('stop:') && !e.startsWith('kill:') && !e.startsWith('start:')));
});

test('an update interrupted between checkpoint and apply restores nothing and starts the app again', async () => {
  const f = ownDatabaseApp();
  await f.prepare();
  // The Control Panel stopped here; recovery at its next start finds the app stopped and nothing applied.
  f.events.length = 0;
  f.record.phase = 'recovering';
  await f.provider.restore(f.record);
  assert.deepEqual(f.events, []);
  assert.equal(f.incus.volumes.get('ye-fixture-postgres-data')!.data, 'rows-1');
  await f.provider.verifyRestored(f.record);
  f.record.rollbackVerifiedAt = 'now';
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events.filter(e => e.startsWith('start:')), [
    'start:app-fixture-postgres', 'start:app-fixture-valkey', 'start:app-fixture-worker', 'start:app-fixture-main',
  ]);
  assert.ok(f.events.indexOf('pg_isready:app-fixture-postgres:fixture') < f.events.indexOf('start:app-fixture-valkey'));
  for (const name of f.containers) assert.equal(f.incus.instances.get(name)!.status, 'Running');
});

test('a committed update reopens in start order and stops again what was stopped before, cleanly', async () => {
  const f = ownDatabaseApp();
  for (const name of f.containers) f.incus.instances.get(name)!.status = 'Stopped';
  f.record.originalRunning['app-fixture-worker'] = false;
  f.record.phase = 'cleanup';
  f.record.commit = { receipt: 'committed' };
  f.record.steps.push({ id: 'oci-replace-0', phase: 'applying', state: 'completed' });
  // After a reboot nothing runs; the worker was stopped by the owner before the update.
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, [
    'start:app-fixture-postgres', 'pg_isready:app-fixture-postgres:fixture', 'start:app-fixture-valkey', 'start:app-fixture-main',
  ]);

  // Right after the apply phase everything runs: the worker is stopped again with a clean stop.
  for (const name of f.containers) f.incus.instances.get(name)!.status = 'Running';
  f.events.length = 0;
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, ['stop:app-fixture-worker:60', 'pg_isready:app-fixture-postgres:fixture']);
});

test('the first start of a new version follows the start order and waits for the database', async () => {
  const f = ownDatabaseApp();
  await f.prepare();
  f.events.length = 0;
  assert.deepEqual(f.provider.startOrder(f.record), [
    'app-fixture-postgres', 'app-fixture-valkey', 'app-fixture-worker', 'app-fixture-main',
  ]);
  for (const name of f.provider.startOrder(f.record)) await f.provider.startRuntime(f.record, name, f.plan.manifest);
  // The app's own health check comes later, once every container runs the new version.
  assert.deepEqual(f.events, [
    'start:app-fixture-postgres', 'pg_isready:app-fixture-postgres:fixture',
    'start:app-fixture-valkey', 'start:app-fixture-worker', 'start:app-fixture-main',
  ]);
});

test('any database sidecar is covered without engine code: a MariaDB container starts first and passes its own health check', async () => {
  const f = ownDatabaseApp();
  // No `database.mode: own`: the role comes from the container's name, readiness from its declared health check.
  f.plan.manifest.database = { mode: 'none' } as never;
  f.plan.metadata.containers[3] = { name: 'mariadb', containerName: 'app-fixture-postgres', type: 'oci' } as never;
  f.plan.manifest.containers[3] = { name: 'mariadb', type: 'oci', image: 'mariadb:11', port: 3306, volumes: [],
    healthCheck: { type: 'http', path: '/' } } as never;
  await f.prepare();
  assert.ok(f.events.includes('snapshot:ye-fixture-postgres-data'));
  assert.equal(f.events.findLast(e => e.startsWith('stop:')), 'stop:app-fixture-postgres:120');
  f.events.length = 0;
  for (const name of f.provider.startOrder(f.record)) await f.provider.startRuntime(f.record, name);
  assert.deepEqual(f.events.slice(0, 3), ['start:app-fixture-postgres', 'health:app-fixture-postgres', 'start:app-fixture-valkey']);
  assert.ok(f.events.every(e => !e.startsWith('pg_isready:')));
});

test("an update that changes the own database engine's image is still refused", () => {
  const f = ownDatabaseApp();
  const old = f.plan.manifest as never as { containers: Array<{ name: string; image: string; type: string }> };
  const target = structuredClone(old);
  target.containers[0].image = 'app:2';
  f.assertOwnDatabaseEngineUnchanged(old, target);
  target.containers[3].image = 'postgres:18-vector';
  assert.throws(() => f.assertOwnDatabaseEngineUnchanged(old, target), preflight('postgres-runtime-change-excluded'));
  target.containers.pop();
  assert.throws(() => f.assertOwnDatabaseEngineUnchanged(old, target), preflight('postgres-runtime-change-excluded'));
});

test('an SQL migration is refused for an app with its own database', async () => {
  const f = ownDatabaseApp();
  await assert.rejects(f.provider.executeSQL(f.record, 'SELECT 1;'), preflight('sql-migration-own-database-unsupported'));
});
