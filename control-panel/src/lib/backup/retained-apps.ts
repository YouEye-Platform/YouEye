import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listRetainedApps, saveRetainedInstallMetadata } from '@/lib/market/metadata';
import { validateRetainedMetadata, verifyRetainedAuthority, verifyRetainedAppData } from '@/lib/admission/retained-data';
import { verifyRetainedRuntime, runtimeExists } from '@/lib/admission/retained-runtime';
import { retainedBinding } from '@/lib/admission/retained-data';
import { listStorageLocations } from '@/lib/market/storage';
import { spineClient } from '@/lib/spine/client';
import { dumpPostgresDatabase, replacePlatformAppDatabase, PLATFORM_POSTGRES_CONTAINER, PLATFORM_POSTGRES_ADMIN } from './postgres';
import type { InstallMetadata } from '@/lib/market/types';
import { identityRows } from '@/lib/identity/store';

export function parseRetainedAppInventory(value: unknown): InstallMetadata[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Unsupported retained app inventory');
  const result = value as InstallMetadata[];
  for (const metadata of result) validateRetainedMetadata(metadata);
  if (new Set(result.map(metadata => metadata.appId)).size !== result.length
    || new Set(result.map(metadata => metadata.installationId)).size !== result.length) {
    throw new Error('Duplicate retained installation');
  }
  return result;
}

export async function readRetainedAppInventory(stagingDir: string): Promise<InstallMetadata[]> {
  const filename = path.join(stagingDir, 'retained-apps.json');
  try {
    const info = await stat(filename);
    if (info.size > 4 * 1024 * 1024) throw new Error('Retained app inventory exceeds its limit');
    return parseRetainedAppInventory(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function validateRetainedArchiveInventory(value: unknown, inventory: InstallMetadata[]) {
  const document = value as { schema?: string; runtimes?: Array<{ name: string; type: string }>;
    volumes?: Array<{ pool: string; name: string }> };
  const roots = new Set(inventory.flatMap(metadata => metadata.retainedRoots!.roots.map(root => root.retainedName)));
  const volumes = new Set(inventory.flatMap(metadata => (metadata.storageVolumes ?? [])
    .filter(volume => !volume.attachmentOnly).map(volume => `${volume.pool}/${volume.name}`)));
  if (document?.schema !== 'youeye.backup.incus.v1' || !Array.isArray(document.runtimes)
    || !Array.isArray(document.volumes) || document.runtimes.length !== roots.size
    || new Set(document.runtimes.map(runtime => runtime.name)).size !== roots.size
    || document.runtimes.some(runtime => !roots.has(runtime.name) || runtime.type !== 'lxd')
    || document.volumes.length !== volumes.size
    || new Set(document.volumes.map(volume => `${volume.pool}/${volume.name}`)).size !== volumes.size
    || document.volumes.some(volume => !volumes.has(`${volume.pool}/${volume.name}`))) {
    throw new Error('Retained archive contains missing, duplicate or foreign resources');
  }
}

function passwordFile(metadata: InstallMetadata) {
  const filename = metadata.databasePasswordFile;
  if (!filename || !/^[A-Za-z0-9._-]+$/.test(filename) || ['.', '..'].includes(filename)) {
    throw new Error('Retained database needs its explicit original credential-file declaration');
  }
  return path.join('/var/lib/youeye', `app-${metadata.appId}`, filename);
}

export async function stageRetainedApps(stagingDir: string) {
  const inventory = parseRetainedAppInventory((await listRetainedApps())
    .filter(metadata => metadata.retainedRoots?.state !== 'adopted'));
  const retainedPolicies = await identityRows<{ app_id: string }>(`SELECT app_id FROM admission_policies WHERE state='retained'`);
  if (retainedPolicies.some(policy => !inventory.some(metadata => metadata.appId === policy.app_id))) {
    throw new Error('A retained policy is missing its durable root recovery map');
  }
  const runtimes: Array<{ name: string; type: 'lxd' }> = [];
  const volumes = new Map<string, { pool: string; name: string }>();
  for (const metadata of inventory) {
    await verifyRetainedAppData(metadata, true);
    // The historic "lxd" archive kind means a full Incus instance export. An
    // OCI retained root must also preserve mutations, not just its base image.
    for (const root of metadata.retainedRoots!.roots) runtimes.push({ name: root.retainedName, type: 'lxd' });
    for (const volume of metadata.storageVolumes ?? []) {
      if (!volume.attachmentOnly) volumes.set(`${volume.pool}/${volume.name}`, { pool: volume.pool, name: volume.name });
    }
    if (metadata.databaseMode === 'shared') {
      if (!(await readFile(passwordFile(metadata), 'utf8')).trim()) throw new Error('Retained database credential is missing');
      await mkdir(path.join(stagingDir, 'retained-databases'), { recursive: true, mode: 0o700 });
      const dump = await dumpPostgresDatabase({ container: PLATFORM_POSTGRES_CONTAINER,
        database: metadata.databaseName || metadata.appId, user: PLATFORM_POSTGRES_ADMIN });
      await writeFile(path.join(stagingDir, 'retained-databases', `${metadata.appId}.sql`), dump, { mode: 0o600 });
    }
  }
  await writeFile(path.join(stagingDir, 'retained-apps.json'), JSON.stringify(inventory), { mode: 0o600 });
  return { inventory, runtimes, volumes: [...volumes.values()],
    paths: inventory.map(metadata => `/var/lib/youeye/app-${metadata.appId}`) };
}

/** Called only after the coherent historical identity DB has been restored. */
export async function restoreRetainedApps(stagingDir: string, inventory: InstallMetadata[]) {
  const retainedPolicies = await identityRows<{ app_id: string }>(`SELECT app_id FROM admission_policies WHERE state='retained'`);
  if (retainedPolicies.some(policy => !inventory.some(metadata => metadata.appId === policy.app_id))) {
    throw new Error('Retained ownership is missing from the encrypted recovery inventory');
  }
  if (!inventory.length) return;
  for (const metadata of inventory) await verifyRetainedAuthority(metadata, ['retained', 'quarantined']);
  const documentPath = path.join(stagingDir, 'incus', 'recovery.json');
  if ((await stat(documentPath)).size > 1024 * 1024) throw new Error('Retained archive inventory exceeds its limit');
  validateRetainedArchiveInventory(JSON.parse(await readFile(documentPath, 'utf8')), inventory);
  const locations = new Set((await listStorageLocations()).map(location => location.id));
  if (!locations.has('default')) throw new Error('Retained data restore has no target storage');
  const sourcePools = new Set(inventory.flatMap(metadata => [
    ...metadata.retainedRoots!.roots.map(root => root.pool), ...(metadata.storageVolumes ?? []).map(volume => volume.pool),
  ]));
  const poolMap = Object.fromEntries([...sourcePools].filter(pool => !locations.has(pool)).map(pool => [pool, 'default']));
  const recovered = await spineClient.prepareIncusRecovery(stagingDir, poolMap);
  const expected = new Set(inventory.flatMap(metadata => metadata.retainedRoots!.roots.map(root => root.retainedName)));
  if (recovered.status !== 'prepared' || recovered.runtimes.length !== expected.size
    || recovered.runtimes.some(runtime => !expected.has(runtime.name) || !runtime.archive_path || runtime.type !== 'lxd')) {
    throw new Error('Retained root recovery inventory is incomplete or foreign');
  }
  for (const metadata of inventory) {
    for (const root of metadata.retainedRoots!.roots) {
      root.pool = poolMap[root.pool] || root.pool;
      const binding = retainedBinding(metadata, root);
      if (await runtimeExists(root.retainedName)) {
        // Never replace a pre-existing root because a restore file says so.
        throw new Error('Retained root already exists on the restore target');
      }
      const runtime = recovered.runtimes.find(runtime => runtime.name === root.retainedName)!;
      await spineClient.importIncusInstance({ archivePath: runtime.archive_path!, name: root.retainedName,
        pool: root.pool, offline: true });
      await verifyRetainedRuntime(binding);
    }
    for (const volume of metadata.storageVolumes ?? []) volume.pool = poolMap[volume.pool] || volume.pool;
    if (metadata.databaseMode === 'shared') {
      const credential = (await readFile(passwordFile(metadata), 'utf8')).trim();
      if (!credential) throw new Error('Restored retained database credential is missing');
      await replacePlatformAppDatabase({ database: metadata.databaseName || metadata.appId,
        user: metadata.databaseUser || metadata.appId, password: credential,
        dump: await readFile(path.join(stagingDir, 'retained-databases', `${metadata.appId}.sql`)) });
    }
    await verifyRetainedAppData(metadata, true);
    await saveRetainedInstallMetadata(metadata);
  }
}
