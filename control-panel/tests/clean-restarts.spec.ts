import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { containerOrder, fakeIncus, loadSnapshot, loadSource } from './fixtures/update-provider-harness';

const SRC = join(import.meta.dirname, '../src');

function box(...running: string[]) {
  const incus = fakeIncus();
  for (const name of running) incus.addInstance(name, 'Running');
  return incus;
}

test('a restart is a clean stop, then a start; forced only after the timeout, with a warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const incus = box('app-notes', 'app-notes-db');
  const snapshot = loadSnapshot(incus);
  await snapshot.restartContainer('app-notes', { timeoutSec: 60 });
  incus.stuck.add('app-notes-db');
  await snapshot.restartContainer('app-notes-db', { timeoutSec: 120 });
  assert.deepEqual(incus.log, [
    'stop:app-notes:60', 'start:app-notes',
    'stop:app-notes-db:120', 'kill:app-notes-db', 'start:app-notes-db',
  ]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /app-notes-db did not stop cleanly within 120 s; forcing it to stop/);
});

test('a restart of a container that is not running fails and starts nothing', async () => {
  const incus = fakeIncus();
  incus.addInstance('app-notes', 'Stopped');
  await assert.rejects(loadSnapshot(incus).restartContainer('app-notes'), /could not restart: it is Stopped/);
  assert.deepEqual(incus.log, []);
});

function deployer(incus: ReturnType<typeof fakeIncus>) {
  return loadSource('lib/infrastructure/oci-deployer.ts', (name) => ({
    '../incus/server': { incusRequest: incus.incusRequest },
    '../incus/snapshot': loadSnapshot(incus),
  } as Record<string, unknown>)[name] ?? {});
}

test('restartContainerAndWait (URL change, AI, setup files) stops cleanly with the role timeout and waits', async () => {
  const incus = box('youeye-postgres', 'app-notes');
  const oci = deployer(incus);
  await oci.restartContainerAndWait('youeye-postgres', 60, { role: 'database' });
  await oci.restartContainerAndWait('app-notes');
  assert.deepEqual(incus.log, ['stop:youeye-postgres:120', 'start:youeye-postgres', 'stop:app-notes:60', 'start:app-notes']);
  assert.equal(incus.instances.get('youeye-postgres')!.status, 'Running');
});

test('settings reach every app container by name; running apps restart cleanly as a whole, stopped ones stay stopped', async () => {
  const incus = box('app-immich-main', 'app-immich-postgres', 'app-notes');
  incus.addInstance('app-memos', 'Stopped');
  const apps = [
    { appId: 'immich', containers: [
      { name: 'main', containerName: 'app-immich-main', type: 'oci', primary: true },
      { name: 'postgres', containerName: 'app-immich-postgres', type: 'oci', role: 'database' },
    ] },
    { appId: 'notes', containers: [{ name: 'main', containerName: 'app-notes', type: 'oci', primary: true }] },
    { appId: 'memos', containers: [{ name: 'main', containerName: 'app-memos', type: 'oci', primary: true }] },
  ];
  const locked: string[] = [];
  const propagation = loadSource('lib/market/propagation.ts', (name) => ({
    '@/lib/incus/server': { incusRequest: incus.incusRequest },
    '@/lib/incus/snapshot': loadSnapshot(incus),
    '@/lib/apps/container-order': containerOrder(),
    './metadata': { listInstalledApps: async () => apps },
    './platform-env': {
      clearPlatformContextCache: () => {},
      getPlatformContext: async () => ({ siteName: 'Home', timezone: 'UTC', locale: 'en', version: '0.6.14' }),
    },
    './update-admission': { withAppLifecycle: async (appId: string, work: () => unknown) => { locked.push(appId); return work(); } },
  } as Record<string, unknown>)[name] ?? {});
  const result = await propagation.propagateSettingsToApps();
  assert.deepEqual(result, { appsUpdated: ['immich', 'notes', 'memos'], appsFailed: [], errors: [] });
  assert.deepEqual(locked, ['immich', 'notes', 'memos']);
  // Each write marks its container as waiting for a restart (the same PATCH); the second PATCH takes the mark away
  // once the container is stopped.
  assert.deepEqual(incus.log, [
    'patch:app-immich-main', 'patch:app-immich-postgres',
    'stop:app-immich-main:60', 'patch:app-immich-main', 'stop:app-immich-postgres:120', 'patch:app-immich-postgres',
    'start:app-immich-postgres', 'start:app-immich-main',
    'patch:app-notes', 'stop:app-notes:60', 'patch:app-notes', 'start:app-notes',
    'patch:app-memos', 'patch:app-memos',
  ]);
  for (const instance of incus.instances.values()) assert.notEqual(instance.config['user.youeye.env-restart-pending'], '1');
  assert.equal(incus.instances.get('app-memos')!.config['environment.YOUEYE_SITE_NAME'], 'Home');
  assert.equal(incus.instances.get('app-memos')!.status, 'Stopped');
});

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

test('a forced Incus stop or restart is only ever sent for a container deleted right after, and says so', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/action:\s*'(stop|restart)'[^}]*?force:\s*true/g)) {
      const before = text.slice(0, match.index).split('\n').slice(-6).join('\n');
      const rel = relative(SRC, file);
      // snapshot.ts holds the one kill helper, used after a clean stop timed out or before a delete.
      if (rel === 'lib/incus/snapshot.ts') continue;
      if (match[1] === 'restart' || !/Forced: the instance is deleted right after/.test(before)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});
