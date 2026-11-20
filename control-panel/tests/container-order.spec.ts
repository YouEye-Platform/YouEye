import assert from 'node:assert/strict';
import test from 'node:test';

import { containerRole, containerTargets, orderContainers } from '../src/lib/apps/container-order';
import type { ContainerMeta } from '../src/lib/market/types';

const container = (appId: string, name: string, extra: Partial<ContainerMeta> = {}): ContainerMeta =>
  ({ name, containerName: `app-${appId}-${name}`, type: 'oci', ...extra });
const roles = (containers: ContainerMeta[]) =>
  Object.fromEntries(containerTargets(containers).map(c => [c.name, c.role]));

test('the main container is the app, whatever the app id holds', () => {
  for (const appId of ['jobboard', 'cronicle', 'mongo-express', 'cachet', 'p14-mariadb', 'queue-it', 'db-admin']) {
    assert.deepEqual(roles([container(appId, 'main', { primary: true })]), { [`app-${appId}-main`]: 'app' }, appId);
    // A single-container app has no primary flag in old records: the first container is the main one.
    assert.deepEqual(roles([{ name: 'main', containerName: `app-${appId}`, type: 'oci' }]), { [`app-${appId}`]: 'app' }, appId);
  }
});

test('a sidecar role is read from its own name, never from the app id', () => {
  assert.deepEqual(roles([
    container('jobboard', 'main', { primary: true }),
    container('jobboard', 'web'),
  ]), { 'app-jobboard-main': 'app', 'app-jobboard-web': 'sidecar' });
  assert.deepEqual(roles([
    container('notes', 'main', { primary: true }),
    container('notes', 'db'), container('notes', 'postgres'), container('notes', 'mariadb'), container('notes', 'mongodb'),
    container('notes', 'valkey'), container('notes', 'redis'), container('notes', 'memcached'), container('notes', 'keydb'),
    container('notes', 'worker'), container('notes', 'cron'), container('notes', 'ml'),
  ]), {
    'app-notes-main': 'app',
    'app-notes-db': 'database', 'app-notes-postgres': 'database', 'app-notes-mariadb': 'database', 'app-notes-mongodb': 'database',
    'app-notes-valkey': 'cache', 'app-notes-redis': 'cache', 'app-notes-memcached': 'cache', 'app-notes-keydb': 'cache',
    'app-notes-worker': 'worker', 'app-notes-cron': 'worker', 'app-notes-ml': 'sidecar',
  });
});

test('a recorded role wins over the name', () => {
  assert.deepEqual(roles([
    container('immich', 'main', { primary: true }),
    container('immich', 'store', { role: 'database' }),
  ]), { 'app-immich-main': 'app', 'app-immich-store': 'database' });
  assert.equal(containerRole([container('immich', 'store', { role: 'database' })], 'app-immich-store'), 'database');
  assert.equal(containerRole([container('immich', 'store', { role: 'database' })], 'app-other'), undefined);
});

test('start: database, cache, sidecar, worker, app; stop: the reverse', () => {
  const targets = containerTargets([
    container('immich', 'main', { primary: true }),
    container('immich', 'postgres', { role: 'database' }),
    container('immich', 'valkey'),
    container('immich', 'ml'),
    container('immich', 'worker'),
  ]);
  assert.deepEqual(orderContainers(targets, 'start').map(c => c.name),
    ['app-immich-postgres', 'app-immich-valkey', 'app-immich-ml', 'app-immich-worker', 'app-immich-main']);
  assert.deepEqual(orderContainers(targets, 'stop').map(c => c.name),
    ['app-immich-main', 'app-immich-worker', 'app-immich-ml', 'app-immich-valkey', 'app-immich-postgres']);
});
