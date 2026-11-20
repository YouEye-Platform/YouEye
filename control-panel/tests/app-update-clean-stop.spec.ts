import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ownDatabaseApp } from './fixtures/update-provider-app';

const SRC = join(import.meta.dirname, '../src');
const preflight = (code: string) => (error: any) => error?.name === 'AppUpdatePreflightError' && error.code === code;

test('an update stops the app first and its database last, each cleanly, the database with the long timeout', async () => {
  const f = ownDatabaseApp();
  await f.provider.quiesce(f.record);
  assert.deepEqual(f.events, [
    'stop:app-fixture-main:60', 'stop:app-fixture-worker:60', 'stop:app-fixture-valkey:60', 'stop:app-fixture-postgres:120',
  ]);
});

test('a container that does not stop in time refuses the update before any checkpoint, and is not killed', async () => {
  const f = ownDatabaseApp();
  f.incus.stuck.add('app-fixture-valkey');
  await assert.rejects(f.provider.quiesce(f.record), (error: any) => preflight('writer-stop-timeout')(error)
    && error.message === 'Update not started: app-fixture-valkey did not stop in time. Nothing was changed.');
  assert.deepEqual(f.events, ['stop:app-fixture-main:60', 'stop:app-fixture-worker:60', 'stop:app-fixture-valkey:60']);
  assert.equal(f.incus.instances.get('app-fixture-postgres')!.status, 'Running');

  // Recovery of the refused update: nothing was changed, so nothing is stopped or restored; what was stopped starts
  // again in start order.
  f.events.length = 0;
  f.record.phase = 'recovering';
  await f.provider.restore(f.record);
  assert.deepEqual(f.events, []);
  f.incus.stuck.clear();
  await f.provider.verifyRestored(f.record);
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events.filter(e => e.startsWith('start:')), ['start:app-fixture-worker', 'start:app-fixture-main']);
  assert.ok(f.events.every(e => !e.startsWith('kill:') && !e.startsWith('stop:')));
});

test('recovery retries a clean stop once, then forces it, because the restore points exist', async (t) => {
  const f = ownDatabaseApp();
  t.mock.method(console, 'warn', () => {});
  await f.prepare();
  f.apply();
  f.incus.stuck.add('app-fixture-postgres');
  f.events.length = 0;
  f.record.phase = 'recovering';
  await f.provider.restore(f.record);
  assert.deepEqual(f.events.slice(0, 6), [
    'stop:app-fixture-main:60', 'stop:app-fixture-worker:60', 'stop:app-fixture-valkey:60',
    'stop:app-fixture-postgres:120', 'stop:app-fixture-postgres:120', 'kill:app-fixture-postgres',
  ]);
  assert.equal(f.incus.volumes.get('ye-fixture-postgres-data')!.data, 'rows-1');
});

test('a recovery fence never forces a stop while a volume has no restore point', async () => {
  const f = ownDatabaseApp();
  await f.provider.quiesce(f.record);
  // Interrupted during checkpointing: one container came back up and will not stop; no volume snapshot exists.
  f.record.phase = 'recovering';
  f.record.steps.push({ id: 'checkpoint-x', phase: 'checkpointing', state: 'intent' });
  f.incus.instances.get('app-fixture-main')!.status = 'Running';
  f.incus.stuck.add('app-fixture-main');
  f.events.length = 0;
  await assert.rejects(f.provider.fenceRecovery(f.record), (error: any) => error?.name === 'ContainerStopTimeoutError');
  assert.deepEqual(f.events, ['stop:app-fixture-main:60', 'stop:app-fixture-main:60']);
});

test('a recovery never forces a container before its runtime copy exists, even with no volume to snapshot', async () => {
  const f = ownDatabaseApp();
  await f.provider.quiesce(f.record);
  // Interrupted during checkpointing: the volumes' snapshots exist, the main container's runtime copy does not.
  f.record.phase = 'checkpointing';
  for (const resource of f.record.resources.filter(r => r.kind === 'volume')) {
    f.record.checkpoints.push(await f.provider.checkpoint(f.record, resource));
  }
  f.record.phase = 'recovering';
  f.incus.instances.get('app-fixture-main')!.status = 'Running';
  f.incus.stuck.add('app-fixture-main');
  f.events.length = 0;
  await assert.rejects(f.provider.fenceRecovery(f.record), (error: any) => error?.name === 'ContainerStopTimeoutError');
  assert.deepEqual(f.events, ['stop:app-fixture-main:60', 'stop:app-fixture-main:60']);
});

test('a recovery never forces a container whose restore points will not be restored: the update failed before its apply phase', async () => {
  const f = ownDatabaseApp();
  // Every restore point exists, but the update failed before it changed anything: restore() restores nothing, so
  // what a kill damaged would stay damaged.
  await f.prepare();
  f.record.phase = 'recovering';
  f.incus.instances.get('app-fixture-postgres')!.status = 'Running';
  f.incus.stuck.add('app-fixture-postgres');
  f.events.length = 0;
  await assert.rejects(f.provider.fenceRecovery(f.record), (error: any) => error?.name === 'ContainerStopTimeoutError');
  assert.deepEqual(f.events, ['stop:app-fixture-postgres:120', 'stop:app-fixture-postgres:120'], 'two clean tries, no kill');
  // And restore() of such a record stops nothing at all.
  f.events.length = 0;
  await f.provider.restore(f.record);
  assert.deepEqual(f.events, []);
  assert.equal(f.incus.volumes.get('ye-fixture-postgres-data')!.data, 'rows-1');
});

test('a recovery forces a container once its own copy and its own volumes have restore points and the update had started to apply', async (t) => {
  const f = ownDatabaseApp();
  t.mock.method(console, 'warn', () => {});
  await f.provider.quiesce(f.record);
  // The main container's copy and its volume's snapshot exist; the database's do not, and do not matter for main.
  f.record.phase = 'checkpointing';
  for (const resource of f.record.resources.filter(r => r.name === 'app-fixture-main' || r.name === 'ye-fixture-main-data')) {
    f.record.checkpoints.push(await f.provider.checkpoint(f.record, resource));
  }
  f.record.phase = 'recovering';
  f.record.steps.push({ id: 'oci-replace-0', phase: 'applying', state: 'intent' });
  f.incus.instances.get('app-fixture-main')!.status = 'Running';
  f.incus.stuck.add('app-fixture-main');
  f.events.length = 0;
  await f.provider.fenceRecovery(f.record);
  assert.deepEqual(f.events.slice(0, 3), ['stop:app-fixture-main:60', 'stop:app-fixture-main:60', 'kill:app-fixture-main']);
  // A stuck database whose copy does not exist yet is still never forced.
  f.incus.instances.get('app-fixture-postgres')!.status = 'Running';
  f.incus.stuck.add('app-fixture-postgres');
  f.events.length = 0;
  await assert.rejects(f.provider.fenceRecovery(f.record), (error: any) => error?.name === 'ContainerStopTimeoutError');
  assert.ok(!f.events.includes('kill:app-fixture-postgres'));
});

test('the update modules never ask Incus for a forced stop', () => {
  const directory = join(SRC, 'lib/market');
  const modules = readdirSync(directory).filter(file => /^update-.*\.ts$/.test(file) || file === 'updater.ts');
  assert.ok(modules.includes('update-provider.ts') && modules.includes('updater.ts'));
  for (const file of modules) {
    const source = readFileSync(join(directory, file), 'utf8');
    assert.doesNotMatch(source, /force\s*:\s*true/, `${file} sends a forced request`);
    assert.doesNotMatch(source, /stopContainerOrForce/, `${file} falls back to a forced stop`);
    if (file !== 'update-provider.ts') assert.doesNotMatch(source, /forceStopContainer/, `${file} forces a stop`);
  }
  // The one forced stop: recovery, after two clean tries, and only once the restore points exist and are restored.
  const provider = readFileSync(join(directory, 'update-provider.ts'), 'utf8');
  assert.equal(provider.match(/forceStopContainer\(/g)?.length, 1);
  const recoveryStop = provider.slice(provider.indexOf('private async stopForRecovery('), provider.indexOf('async startRuntime('));
  assert.match(recoveryStop, /if \(!this\.mutated\(record\) \|\| !this\.restorePointsTaken\(record, plan, name\)\) throw error;[\s\S]*await forceStopContainer\(name\);/);
});
