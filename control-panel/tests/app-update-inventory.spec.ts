import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppUpdatePreflightError, planAppUpdateInventory, type UpdateInventoryObservations,
} from '../src/lib/market/update-inventory';
import type { AppManifest, InstallMetadata } from '../src/lib/market/types';

function fixture() {
  const metadata = {
    appId: 'fixture', lifecycleState: 'active', databaseMode: 'shared',
    databaseName: 'fixture', databaseUser: 'fixture',
    containers: [{ name: 'main', containerName: 'app-fixture', type: 'oci' }],
    storageVolumes: [
      { appId: 'fixture', pool: 'default', name: 'ye-fixture-data', logicalName: 'data',
        containerName: 'app-fixture', containerPath: '/data', type: 'data', readOnly: true, backup: true },
      { appId: 'fixture', pool: 'default', name: 'ye-fixture-data', logicalName: 'config',
        containerName: 'app-fixture', containerPath: '/config', type: 'config', readOnly: false,
        backup: true, attachmentOnly: true, sourcePath: 'config' },
    ],
  } as InstallMetadata;
  const old = {
    metadata: { id: 'fixture' }, database: { mode: 'shared', name: '${app.id}', user: '${app.id}' },
    containers: [{ name: 'main', type: 'oci', volumes: [
      { name: 'data', type: 'data', container: '/data', read_only: true },
      { name: 'config', type: 'config', container: '/config', read_only: false,
        sourceVolume: 'data', sourcePath: 'config' },
    ] }],
  } as AppManifest;
  const target = structuredClone(old);
  const observations: UpdateInventoryObservations = {
    containers: [{ name: 'app-fixture', ownerAppId: 'fixture', state: 'Stopped', rootPool: 'default',
      oldRuntimeAvailable: true, restoreSupported: true,
      volumes: [{ pool: 'default', name: 'ye-fixture-data', readOnly: false }] }],
    volumes: [{ pool: 'default', name: 'ye-fixture-data', ownerAppId: 'fixture',
      contentType: 'filesystem', snapshotSupported: true, users: ['app-fixture'] }],
    databases: [{ engine: 'youeye-postgres', name: 'fixture', ownerAppId: 'fixture',
      ownerRole: 'fixture', logicalRestoreSupported: true, writers: ['app-fixture'] }],
    pools: [{ name: 'default', availableBytes: 1000, checkpointBytes: 500, cleanupReserveBytes: 100 }],
  };
  return { metadata, old, target, observations };
}

function rejected(f: ReturnType<typeof fixture>, code: string) {
  assert.throws(() => planAppUpdateInventory(f.metadata, f.old, f.target, f.observations),
    (error: unknown) => error instanceof AppUpdatePreflightError && error.code === code);
}

test('backing volume aliases deduplicate without discarding a writable subpath or original stopped state', () => {
  const f = fixture();
  const result = planAppUpdateInventory(f.metadata, f.old, f.target, f.observations);
  assert.equal(result.resources.filter(r => r.kind === 'volume').length, 1);
  assert.equal(result.resources.find(r => r.kind === 'volume')?.mutable, true);
  // No reservation is shared with another app's update: a stuck update never blocks other apps.
  assert.deepEqual(result.resources.filter(r => r.kind === 'capacity'), []);
  assert.deepEqual(result.originalRunning, { 'app-fixture': false });
  assert.deepEqual(result.databases, [
    { mode: 'shared', engine: 'youeye-postgres', name: 'fixture', ownerRole: 'fixture' },
  ]);
});

test('unknown live attachments, missing attachments and foreign volume ownership fail before effects', () => {
  let f = fixture();
  f.observations.containers[0].volumes.push({ pool: 'default', name: 'foreign-data', readOnly: false });
  rejected(f, 'unknown-mutable-volume');
  f = fixture();
  f.observations.containers[0].volumes = [];
  rejected(f, 'missing-volume-attachment');
  f = fixture();
  f.observations.volumes[0].ownerAppId = 'other';
  rejected(f, 'foreign-volume');
});

test('writable sharing and unidentified writers refuse the finite v1 boundary', () => {
  let f = fixture();
  f.observations.volumes[0].users.push('app-other');
  rejected(f, 'unsupported-shared-resource');
  f = fixture();
  f.observations.databases[0].writers.push('unknown-client');
  rejected(f, 'unsupported-shared-resource');
});

test('a writable shared folder is updated in place: no checkpoint, reservation or budget, definition unchanged', () => {
  const f = fixture();
  f.metadata.storageVolumes!.forEach(v => { v.sharedGroup = 'media'; });
  for (const manifest of [f.old, f.target]) {
    manifest.containers[0].volumes.forEach(v => { v.storageGroup = 'media'; });
  }
  f.observations.volumes[0].sharedGroup = 'media';
  // Other apps write the same media library (sonarr, radarr, qbittorrent).
  f.observations.volumes[0].users.push('app-radarr', 'app-qbittorrent');
  const result = planAppUpdateInventory(f.metadata, f.old, f.target, f.observations);
  assert.deepEqual(result.sharedFolders, ['media']);
  assert.equal(result.resources.some(r => r.kind === 'volume'), false, 'never a recovery or reservation resource');
  assert.deepEqual(result.volumes, []);
  f.target.containers[0].volumes[0].container = '/media';
  rejected(f, 'unsupported-storage-topology-change');
});

test('read-only shared folders are not rewound either, and changed definitions refuse', () => {
  const f = fixture();
  f.metadata.storageVolumes!.forEach(v => { v.readOnly = true; v.sharedGroup = 'media'; });
  for (const m of [f.old, f.target]) {
    m.containers[0].volumes.forEach(v => { v.read_only = true; v.storageGroup = 'media'; });
  }
  f.observations.containers[0].volumes[0].readOnly = true;
  f.observations.volumes[0].sharedGroup = 'media';
  f.observations.volumes[0].users.push('app-other');
  const result = planAppUpdateInventory(f.metadata, f.old, f.target, f.observations);
  assert.deepEqual(result.sharedFolders, ['media']);
  assert.equal(result.resources.some(r => r.kind === 'volume'), false);
  f.target.containers[0].volumes[0].container = '/changed';
  rejected(f, 'unsupported-storage-topology-change');
});

test('platform database, foreign role, target identity change and unknown logical recovery are refused', () => {
  let f = fixture();
  for (const manifest of [f.old, f.target]) manifest.database!.name = 'youeye_ui';
  rejected(f, 'platform-database-excluded');
  f = fixture();
  f.observations.databases[0].ownerRole = 'other';
  rejected(f, 'foreign-or-unknown-database');
  f = fixture();
  f.target.database!.name = 'new_database';
  rejected(f, 'unsupported-database-topology-change');
  f = fixture();
  f.observations.databases[0].logicalRestoreSupported = false;
  rejected(f, 'database-recovery-unavailable');
});

test('missing pool, full capacity, unknown runtime and unavailable previous image refuse', () => {
  let f = fixture();
  f.observations.pools = [];
  rejected(f, 'insufficient-recovery-capacity');
  f = fixture();
  f.observations.pools[0].availableBytes = 599;
  rejected(f, 'insufficient-recovery-capacity');
  f = fixture();
  f.observations.containers[0].oldRuntimeAvailable = false;
  rejected(f, 'old-runtime-unavailable');
  f = fixture();
  f.observations.containers[0].state = 'Unknown' as 'Stopped';
  rejected(f, 'unknown-container-state');
});

function ownDatabaseFixture() {
  const f = fixture();
  f.metadata.databaseMode = 'own';
  delete f.metadata.databaseName;
  delete f.metadata.databaseUser;
  f.metadata.containers.push({ name: 'postgres', containerName: 'app-fixture-postgres',
    type: 'oci', role: 'database' });
  for (const manifest of [f.old, f.target]) {
    manifest.database = { mode: 'own', container: 'postgres', name: 'fixture', user: 'fixture' };
    manifest.containers.push({ name: 'postgres', type: 'oci',
      volumes: [{ name: 'data', container: '/var/lib/postgresql/data', type: 'data', read_only: false }] } as AppManifest['containers'][number]);
  }
  f.metadata.storageVolumes!.push({ appId: 'fixture', containerName: 'app-fixture-postgres',
    logicalName: 'data', name: 'ye-fixture-postgres-data', pool: 'default',
    containerPath: '/var/lib/postgresql/data', type: 'data', readOnly: false, backup: true });
  f.observations.containers.push({ name: 'app-fixture-postgres', ownerAppId: 'fixture',
    rootPool: 'default', state: 'Running', oldRuntimeAvailable: true, restoreSupported: true,
    volumes: [{ pool: 'default', name: 'ye-fixture-postgres-data', readOnly: false }] });
  f.observations.volumes.push({ pool: 'default', name: 'ye-fixture-postgres-data',
    ownerAppId: 'fixture', contentType: 'filesystem', snapshotSupported: true,
    users: ['app-fixture-postgres'] });
  // Nothing is asked of the database itself: no admin role, no catalog, no logical restore.
  f.observations.databases = [];
  return f;
}

test('an app-owned database is its engine container and mutable volumes: no database resource, no logical recovery', () => {
  const f = ownDatabaseFixture();
  const planned = planAppUpdateInventory(f.metadata, f.old, f.target, f.observations);
  assert.deepEqual(planned.databases, []);
  assert.equal(planned.resources.some(r => r.kind === 'database'), false);
  assert.equal(planned.resources.find(r => r.kind === 'volume' && r.name === 'ye-fixture-postgres-data')!.mutable, true);
  assert.ok(planned.resources.some(r => r.kind === 'container' && r.name === 'app-fixture-postgres' && r.mutable));
  assert.equal(planned.originalRunning['app-fixture-postgres'], true);
  // The recovery declaration for backups is not needed for an update.
  assert.equal(f.old.backup, undefined);
});

test('an app-owned database must keep its files in its own declared storage and keep its declaration', () => {
  let f = ownDatabaseFixture();
  f.metadata.containers[1].role = 'sidecar';
  rejected(f, 'foreign-database-engine');

  f = ownDatabaseFixture();
  f.metadata.storageVolumes = f.metadata.storageVolumes!.filter(v => v.containerName !== 'app-fixture-postgres');
  for (const manifest of [f.old, f.target]) manifest.containers[1].volumes = [];
  f.observations.containers[1].volumes = [];
  f.observations.volumes.pop();
  rejected(f, 'own-database-storage-undeclared');

  // The engine's files mounted into another container of the app.
  f = ownDatabaseFixture();
  for (const manifest of [f.old, f.target]) {
    manifest.containers[0].volumes.push({ name: 'pgdata', container: '/pgdata', type: 'data', read_only: false,
      sourceContainer: 'postgres', sourceVolume: 'data' } as AppManifest['containers'][number]['volumes'][number]);
  }
  f.metadata.storageVolumes!.push({ appId: 'fixture', containerName: 'app-fixture', logicalName: 'pgdata',
    name: 'ye-fixture-postgres-data', pool: 'default', containerPath: '/pgdata', type: 'data', readOnly: false,
    backup: true });
  f.observations.containers[0].volumes.push({ pool: 'default', name: 'ye-fixture-postgres-data', readOnly: false });
  f.observations.volumes[1].users.push('app-fixture');
  rejected(f, 'unsupported-shared-resource');

  // A writer outside the app on the engine's volume.
  f = ownDatabaseFixture();
  f.observations.volumes[1].users.push('app-other');
  rejected(f, 'unsupported-shared-resource');

  f = ownDatabaseFixture();
  f.target.database = { mode: 'own', container: 'postgres', name: 'renamed', user: 'fixture' };
  rejected(f, 'unsupported-database-topology-change');
});

test('a root-only native runtime still requires recovery and cleanup capacity', () => {
  const f = fixture();
  f.metadata.storageVolumes = [];
  f.observations.containers[0].volumes = [];
  for (const manifest of [f.old, f.target]) {
    manifest.containers[0].type = 'lxd';
    manifest.containers[0].volumes = [];
  }
  f.metadata.containers[0].type = 'lxd';
  f.observations.pools[0].cleanupReserveBytes = 0;
  rejected(f, 'insufficient-recovery-capacity');
});

test('manifest storage cannot disappear from the install record while live inventory is empty', () => {
  const f = fixture();
  f.metadata.storageVolumes = [];
  f.observations.containers[0].volumes = [];
  f.observations.volumes = [];
  rejected(f, 'missing-declared-storage');
});

test('a sidecar mounting main\'s volume (from: main) is one volume on two of the app\'s containers', () => {
  const metadata = {
    appId: 'gramps', lifecycleState: 'active', databaseMode: 'none',
    containers: [{ name: 'worker', containerName: 'app-gramps-worker', type: 'oci' },
      { name: 'main', containerName: 'app-gramps-main', type: 'oci' }],
    storageVolumes: [
      { appId: 'gramps', pool: 'default', name: 'ye-gramps-main-gramps', logicalName: 'gramps',
        containerName: 'app-gramps-main', containerPath: '/root/.gramps', type: 'data', readOnly: false, backup: true },
      { appId: 'gramps', pool: 'default', name: 'ye-gramps-main-gramps', logicalName: 'gramps',
        containerName: 'app-gramps-worker', containerPath: '/root/.gramps', type: 'data', readOnly: false,
        backup: true, attachmentOnly: true },
    ],
  } as InstallMetadata;
  const old = {
    metadata: { id: 'gramps' }, database: { mode: 'none' },
    containers: [
      { name: 'worker', type: 'oci', volumes: [{ name: 'gramps', type: 'data', container: '/root/.gramps', read_only: false,
        sourceVolume: 'gramps', sourceContainer: 'main' }] },
      { name: 'main', type: 'oci', primary: true, volumes: [{ name: 'gramps', type: 'data', container: '/root/.gramps', read_only: false }] },
    ],
  } as unknown as AppManifest;
  const attached = { pool: 'default', name: 'ye-gramps-main-gramps', readOnly: false };
  const observations: UpdateInventoryObservations = {
    containers: ['app-gramps-worker', 'app-gramps-main'].map(name => ({ name, ownerAppId: 'gramps', state: 'Running' as const,
      rootPool: 'default', oldRuntimeAvailable: true, restoreSupported: true, volumes: [attached] })),
    volumes: [{ pool: 'default', name: 'ye-gramps-main-gramps', ownerAppId: 'gramps', contentType: 'filesystem',
      snapshotSupported: true, users: ['app-gramps-worker', 'app-gramps-main'] }],
    databases: [],
    pools: [{ name: 'default', availableBytes: 1000, checkpointBytes: 500, cleanupReserveBytes: 100 }],
  };
  const result = planAppUpdateInventory(metadata, old, structuredClone(old), observations);
  assert.deepEqual(result.resources.filter(r => r.kind === 'volume').map(r => r.name), ['ye-gramps-main-gramps']);
});
