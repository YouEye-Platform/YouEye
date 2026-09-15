import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { appVolumeName, sharedVolumeName } from '../src/lib/market/storage';

async function source(path: string) {
  return readFile(join(process.cwd(), path), 'utf8');
}

test('app storage has stable, bounded Incus identities', () => {
  assert.equal(appVolumeName('immich', 'server', 'photos'), 'ye-immich-server-photos');
  assert.equal(sharedVolumeName('media'), 'ye-shared-media');
  assert.throws(() => appVolumeName('../bad', 'server', 'data'));
  assert.throws(() => sharedVolumeName('Media'));
});

test('app storage is Incus-owned and disconnected pools fail closed', async () => {
  const storage = await source('src/lib/market/storage.ts');
  const oci = await source('src/lib/infrastructure/oci-deployer.ts');
  const prober = await source('src/lib/market/app-prober.ts');
  const status = await source('src/app/api/market/status/route.ts');

  assert.match(storage, /security\.shifted/);
  assert.match(storage, /pool-disconnected/);
  assert.match(storage, /storage-pools\/\$\{encode\(volume\.pool\)\}\/resources/);
  assert.match(storage, /configured-but-disconnected pool/);
  assert.match(storage, /must never cause YouEye\s+\* to recreate an empty replacement volume/);
  assert.match(oci, /type: 'disk'/);
  assert.match(oci, /pool: vol\.pool/);
  assert.doesNotMatch(oci, /mkdir.*volume\.host/s);
  assert.match(prober, /storage is disconnected/);
  assert.match(status, /storageStatus/);
});

test('generated configuration uses the Incus file contract and exact post-start permissions', async () => {
  const incus = await source('src/lib/incus/server.ts');
  const writer = await source('src/lib/market/config-writer.ts');
  const engine = await source('src/lib/market/engine.ts');

  assert.match(incus, /X-Incus-mode/);
  assert.match(incus, /incusCreateVolumeDirectory/);
  assert.match(incus, /incusInspectVolumeFile/);
  assert.match(incus, /X-Incus-write/);
  assert.match(incus, /storage-pools.*volumes\/custom.*files\?path/s);
  assert.doesNotMatch(incus, /X-LXD-(?:mode|create-dirs|write)/);
  assert.match(writer, /incusUploadVolumeFile/);
  assert.match(writer, /incusDownloadVolumeFile/);
  assert.match(writer, /deepestConfigStorageMount/);
  assert.match(writer, /App configuration cannot target read-only storage/);
  assert.match(writer, /ensureVolumeConfigParent/);
  assert.match(writer, /App configuration did not read back exactly from durable storage/);
  assert.match(writer, /enforceConfigFilePermissions/);
  assert.match(writer, /App configuration permissions did not read back exactly/);
  assert.match(engine, /deepestConfigStorageMount/);
  assert.match(engine, /App configuration cannot target read-only storage/);
  assert.match(engine, /App configuration cannot target ephemeral cache storage/);
  assert.match(engine, /writeAllConfigFiles\([\s\S]*?containerSpec\.type === 'oci'[\s\S]*?volumesForContainer\(storageVolumes, containerName\)/);
  assert.match(engine, /enforceAllConfigFilePermissions/);
});

test('uninstall treats an unrequested shared database cleanup as inapplicable', async () => {
  const uninstaller = await source('src/lib/market/uninstaller.ts');

  assert.match(uninstaller, /let databaseDropped: boolean \| null = droppedDb \? false : null/);
  assert.match(uninstaller, /verification\.databaseDropped === false/);
});

test('backup and restore carry exact Incus runtime and volume assets', async () => {
  const backup = await source('src/lib/backup/app-backup.ts');
  const restore = await source('src/lib/backup/app-restore.ts');
  const spineClient = await source('src/lib/spine/client.ts');
  const spine = await source('../spine/internal/backup/incus.go');

  assert.match(backup, /incus_runtimes/);
  assert.match(backup, /incus_volumes/);
  assert.match(backup, /volume\.containerName !== logicalDatabaseContainer/);
  assert.match(restore, /prepareIncusRecovery/);
  assert.match(restore, /runtimeImages/);
  assert.match(restore, /runtimeInstances/);
  assert.match(spineClient, /Array\.isArray\(response\.runtimes\)/);
  assert.match(spineClient, /Array\.isArray\(response\.volumes\)/);
  assert.match(spine, /youeye\.backup\.incus\.v1/);
  assert.match(spine, /image.*export/s);
  assert.match(spine, /image.*set-property.*type=oci/s);
  assert.match(spine, /storage.*volume.*export/s);
});
