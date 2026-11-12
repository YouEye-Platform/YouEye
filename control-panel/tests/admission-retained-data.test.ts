import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRetainedMetadata, validateRetainedManifest, consumeRetainedRecovery } from '../src/lib/admission/retained-data';
import { parseRetainedAppInventory, validateRetainedArchiveInventory } from '../src/lib/backup/retained-apps';
import type { InstallMetadata, AppManifest } from '../src/lib/market/types';

const metadata = {
  appId: 'app-a', installationId: '10000000-0000-4000-8000-000000000001',
  integration: 'basic', installedVersion: '1.0.0', manifestDigest: 'original-digest',
  databaseMode: 'none', containers: [{ containerName: 'app-app-a', name: 'main', type: 'oci' }],
  retainedRoots: { schemaVersion: 1, state: 'ready', roots: [{
    sourceName: 'app-app-a', retainedName: 'ye-retained-10000000000040008000000000000001-0',
    ownerId: '10000000-0000-4000-8000-000000000002', pool: 'source-pool',
  }] },
} as InstallMetadata;

test('adoption refuses failed consumption writes and tolerates cleanup only after durable consumption', async () => {
  let cleanupCalls = 0;
  await assert.rejects(consumeRetainedRecovery(metadata, async () => {
    throw new Error('durable write failed');
  }, async () => { cleanupCalls++; }), /durable write failed/);
  assert.equal(cleanupCalls, 0);
  assert.equal(metadata.retainedRoots!.state, 'ready');

  let durable: InstallMetadata | undefined;
  assert.equal(await consumeRetainedRecovery(metadata, async value => {
    durable = structuredClone(value);
  }, async () => {
    assert.equal(durable!.retainedRoots!.state, 'adopted');
    throw new Error('provider cleanup unavailable');
  }), false);
  assert.equal(durable!.retainedRoots!.state, 'adopted');
  assert.equal(metadata.retainedRoots!.state, 'ready');
});

test('versioned retained inventory rejects hostile principals, logical bindings and database targets', () => {
  assert.equal(parseRetainedAppInventory([structuredClone(metadata)]).length, 1);
  for (const modify of [
    (value: any) => { value.retainedRoots.schemaVersion = 2; },
    (value: any) => { value.retainedRoots.state = 'preparing'; },
    (value: any) => { value.retainedRoots.roots[0].ownerId = 'owner-display-name'; },
    (value: any) => { value.retainedRoots.roots[0].sourceName = 'app-other'; },
    (value: any) => { value.retainedRoots.roots[0].retainedName = 'foreign-instance'; },
    (value: any) => { value.retainedRoots.roots[0].pool = '../pool'; },
    (value: any) => { value.databaseMode = 'shared'; value.databaseName = 'youeye'; value.databaseUser = 'app_a'; },
    (value: any) => { value.databaseMode = 'shared'; value.databaseName = 'app_a'; value.databaseUser = 'youeye'; },
    (value: any) => { value.storageVolumes = [{ appId: 'app-b', name: 'foreign', pool: 'default' }]; },
  ]) {
    const value = structuredClone(metadata);
    modify(value);
    assert.throws(() => validateRetainedMetadata(value));
  }
  assert.throws(() => parseRetainedAppInventory([metadata, metadata]), /Duplicate/);
  assert.throws(() => parseRetainedAppInventory({ schemaVersion: 1 }));
});

test('retained adoption cannot silently change app, runtime, manifest version or source', () => {
  const manifest = { metadata: { id: 'app-a' }, version: '1.0.0', integration: 'basic',
    containers: [{ name: 'main', type: 'oci' }], database: { mode: 'none' } } as AppManifest;
  const config = { appId: 'app-a', subdomain: 'a', domain: 'example.test', manifestDigest: 'original-digest' };
  validateRetainedManifest(metadata, manifest, config);
  assert.throws(() => validateRetainedManifest(metadata, { ...manifest, version: '2.0.0' }, config));
  assert.throws(() => validateRetainedManifest(metadata, manifest, { ...config, manifestDigest: 'changed' }));
  assert.throws(() => validateRetainedManifest(metadata, { ...manifest, metadata: { id: 'app-b' } } as AppManifest, config));
  assert.throws(() => validateRetainedManifest(metadata, { ...manifest, containers: [{ name: 'main', type: 'lxd' }] } as AppManifest, config));
});

test('retained archive authority rejects extra, missing and duplicate resources before provider import', () => {
  const document = { schema: 'youeye.backup.incus.v1',
    runtimes: [{ name: metadata.retainedRoots!.roots[0].retainedName, type: 'lxd' }], volumes: [] };
  validateRetainedArchiveInventory(document, [metadata]);
  assert.throws(() => validateRetainedArchiveInventory({ ...document, runtimes: [] }, [metadata]));
  assert.throws(() => validateRetainedArchiveInventory({ ...document,
    runtimes: [...document.runtimes, ...document.runtimes] }, [metadata]));
  assert.throws(() => validateRetainedArchiveInventory({ ...document,
    volumes: [{ pool: 'default', name: 'foreign-data' }] }, [metadata]));
  assert.throws(() => validateRetainedArchiveInventory({ ...document,
    runtimes: [{ name: 'foreign-instance', type: 'lxd' }] }, [metadata]));
});
