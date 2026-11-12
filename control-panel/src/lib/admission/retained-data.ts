import {
  readRetainedInstallMetadata, saveRetainedInstallMetadata, removeRetainedInstallMetadata,
} from '@/lib/market/metadata';
import type { AppManifest, InstallConfig, InstallMetadata, RestoreOptions } from '@/lib/market/types';
import { getAdmissionPolicy, getAdmissionSnapshot } from './store';
import { identityRows as rows, identitySql as sql } from '@/lib/identity/store';
import {
  retainRuntime, verifyRetainedRuntime, deleteRetainedRuntime, runtimeRootPool,
  type RetainedRuntimeBinding,
} from './retained-runtime';
import { getContainerName } from '@/lib/market/engine-helpers';
import { isAppId, isUuid } from '../../../../shared/admission';
import { PLATFORM_DATABASES } from '@/lib/backup/postgres';

async function runtimeOwners(appId: string) {
  const resources = await rows<{ resource_id: string; owner_id: string }>(`
    SELECT r.resource_id, r.owner_id::text FROM admission_resources r
    JOIN admission_policies USING (installation_id) WHERE app_id = ${sql(appId)} AND resource_id LIKE 'runtime:%'`);
  return Object.fromEntries(resources.map(resource => [resource.resource_id, resource.owner_id]));
}
export function retainedBinding(
  metadata: InstallMetadata, root: NonNullable<InstallMetadata['retainedRoots']>['roots'][number],
): RetainedRuntimeBinding {
  if (!metadata.installationId || !isUuid(metadata.installationId)
    || !isUuid(root.ownerId) || !metadata.containers.some(c => c.containerName === root.sourceName)) {
    throw new Error('Invalid retained data declaration');
  }
  return { appId: metadata.appId, installationId: metadata.installationId, ...root };
}

export function validateRetainedMetadata(metadata: InstallMetadata) {
  const retained = metadata.retainedRoots;
  if (!isAppId(metadata.appId) || !isUuid(metadata.installationId)
    || !Array.isArray(metadata.containers) || !metadata.containers.length || metadata.containers.length > 100
    || retained?.schemaVersion !== 1 || retained.state !== 'ready' || !Array.isArray(retained.roots)
    || retained.roots.length !== metadata.containers.length
    || new Set(retained.roots.map(r => r.sourceName)).size !== retained.roots.length
    || new Set(retained.roots.map(r => r.retainedName)).size !== retained.roots.length) {
    throw new Error('Retained data metadata is incomplete or unsupported');
  }
  for (const [index, root] of retained.roots.entries()) {
    retainedBinding(metadata, root);
    if (root.retainedName !== `ye-retained-${metadata.installationId!.replaceAll('-', '')}-${index}`
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(root.pool)
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(root.sourceName)) {
      throw new Error('Retained root has an invalid logical binding');
    }
  }
  if (!Array.isArray(metadata.storageVolumes ?? []) || (metadata.storageVolumes?.length ?? 0) > 1000) {
    throw new Error('Invalid retained volume inventory');
  }
  for (const volume of metadata.storageVolumes ?? []) {
    if (volume.appId !== metadata.appId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(volume.name)
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(volume.pool) || !isUuid(volume.dataOwnerId)
      || (!volume.sharedGroup && volume.installationId !== metadata.installationId)
      || (volume.sharedGroup && !isUuid(volume.shareId))) {
      throw new Error('Invalid retained volume ownership');
    }
  }
  if (metadata.databaseMode === 'shared') {
    for (const identifier of [metadata.databaseName, metadata.databaseUser]) {
      if (!identifier || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(identifier)
        || ['postgres', 'template0', 'template1', ...PLATFORM_DATABASES].includes(identifier)) {
        throw new Error('Invalid retained app database identity');
      }
    }
  }
}

export async function verifyRetainedAuthority(metadata: InstallMetadata, states = ['retained']) {
  validateRetainedMetadata(metadata);
  const policy = await getAdmissionPolicy(metadata.appId);
  if (!policy || policy.installationId !== metadata.installationId || !states.includes(policy.state)) {
    throw new Error('Retained data does not match current ownership');
  }
  const owners = await runtimeOwners(metadata.appId);
  for (const root of metadata.retainedRoots!.roots) {
    if (owners[`runtime:${root.sourceName}`] !== root.ownerId) throw new Error('Retained root data owner changed');
  }
  const resources = await rows<{ resource_id: string; owner_id: string; declaration: {
    installationId: string; appId: string; shareId: string | null; consumerIds: string[];
  } }>(`SELECT resource_id, owner_id::text, declaration FROM admission_resources
    WHERE installation_id = ${sql(metadata.installationId)}::uuid`);
  for (const volume of metadata.storageVolumes ?? []) {
    const resource = resources.find(resource => resource.resource_id === `volume:${volume.name}`);
    if (!resource || resource.owner_id !== volume.dataOwnerId
      || resource.declaration.installationId !== metadata.installationId
      || resource.declaration.appId !== metadata.appId
      || (volume.sharedGroup && (resource.declaration.shareId !== volume.shareId
        || !resource.declaration.consumerIds.includes(metadata.installationId!)))) {
      throw new Error('Retained volume is not declared for this installation');
    }
  }
  if (metadata.databaseMode === 'shared'
    && !resources.some(resource => resource.resource_id === `database:${metadata.databaseName}`)) {
    throw new Error('Retained database has no authoritative ownership declaration');
  }
}

async function verifyRecord(metadata: InstallMetadata, state: 'retained' | 'ready' | 'quarantined') {
  await verifyRetainedAuthority(metadata, [state]);
  for (const root of metadata.retainedRoots!.roots) {
    await verifyRetainedRuntime(retainedBinding(metadata, root));
  }
}

export async function verifyRetainedAppData(metadata: InstallMetadata, allowQuarantined = false) {
  const policy = await getAdmissionPolicy(metadata.appId);
  await verifyRecord(metadata, allowQuarantined && policy?.state === 'quarantined' ? 'quarantined' : 'retained');
  const { verifyAppStorageOwnership, inspectAppStorage } = await import('@/lib/market/storage');
  await verifyAppStorageOwnership(metadata.storageVolumes ?? []);
  if (!(await inspectAppStorage(metadata.storageVolumes ?? [])).available) {
    throw new Error('Retained app storage is unavailable');
  }
}

/** Durable recovery map is written before any provider copy or source deletion. */
export async function retainAppRoots(metadata: InstallMetadata) {
  const previous = await readRetainedInstallMetadata(metadata.appId);
  if (previous?.retainedRoots?.state === 'adopted') {
    await cleanupAdoptedRoots(previous);
  } else if (previous) {
    if (previous.installationId !== metadata.installationId) throw new Error('Foreign retained installation');
    metadata.retainedRoots = previous.retainedRoots;
  }
  if (!metadata.retainedRoots) {
    const owners = await runtimeOwners(metadata.appId);
    const roots = [];
    for (const [index, container] of metadata.containers.entries()) {
      const ownerId = owners[`runtime:${container.containerName}`];
      if (!isUuid(ownerId) || !isUuid(metadata.installationId)) throw new Error('Root data owner is unresolved');
      roots.push({ sourceName: container.containerName, ownerId,
        retainedName: `ye-retained-${metadata.installationId!.replaceAll('-', '')}-${index}`,
        pool: await runtimeRootPool(container.containerName) });
    }
    metadata.retainedRoots = { schemaVersion: 1, state: 'preparing', roots };
    await saveRetainedInstallMetadata(metadata);
  }
  for (const root of metadata.retainedRoots.roots) await retainRuntime(retainedBinding(metadata, root));
  metadata.retainedRoots.state = 'ready';
  await saveRetainedInstallMetadata(metadata);
  await verifyRecord(metadata, 'retained');
}

/** Shape/version changes need an update or explicit recovery, not silent data adoption. */
export function validateRetainedManifest(metadata: InstallMetadata, manifest: AppManifest, config: InstallConfig) {
  if (metadata.appId !== manifest.metadata.id
    || metadata.installedVersion !== (manifest.version ?? '')
    || (metadata.manifestDigest && metadata.manifestDigest !== (manifest.frozen?.digest ?? config.manifestDigest))
    || metadata.integration !== manifest.integration
    || metadata.containers.length !== manifest.containers.length
    || !manifest.containers.every(container => metadata.containers.some(existing =>
      existing.containerName === getContainerName(metadata.appId, container.name, manifest.containers.length)
      && existing.type === container.type))
    || (metadata.databaseMode ?? 'none') !== (manifest.database?.mode ?? 'none')
    || (metadata.databaseMode === 'shared'
      && (metadata.databaseName !== manifest.database?.name || metadata.databaseUser !== manifest.database?.user))) {
    throw new Error('Retained data requires the original app manifest/version; adopt it before updating');
  }
}

export async function prepareRetainedAdoption(
  manifest: AppManifest, config: InstallConfig,
): Promise<RestoreOptions | undefined> {
  const metadata = await readRetainedInstallMetadata(manifest.metadata.id);
  if (!metadata) {
    if (config.adoptRetainedData) throw new Error('No retained app data is available to adopt');
    return undefined;
  }
  if (config.adoptRetainedData !== true || !config.admissionActorId) {
    throw new Error('Retained data requires an explicit authenticated owner adoption');
  }
  const snapshot = await getAdmissionSnapshot(metadata.appId);
  const actor = snapshot?.principals.find(p => p.id === config.admissionActorId);
  if (!snapshot || snapshot.policy.ownerId !== actor?.id || !actor.active || actor.deleted) {
    throw new Error('Only the active app owner may adopt retained data');
  }
  validateRetainedManifest(metadata, manifest, config);
  await verifyRecord(metadata, 'retained');
  // Preserve exact pool placement and logical custom-volume identities.
  const placements: Record<string, string> = {};
  for (const volume of metadata.storageVolumes ?? []) {
    if (volume.sharedGroup || volume.attachmentOnly) continue;
    if (placements[volume.type] && placements[volume.type] !== volume.pool) {
      throw new Error('Retained storage placement needs explicit recovery');
    }
    placements[volume.type] = volume.pool;
  }
  config.storage = { placements };
  await verifyRetainedAppData(metadata);
  if (metadata.databaseMode === 'shared') {
    // The ordinary restore installer skips creation, so verify presence first.
    const { execCommand } = await import('@/lib/incus/server');
    const result = await execCommand('youeye-postgres', ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-tAc',
      `SELECT (EXISTS(SELECT 1 FROM pg_database WHERE datname=${sql(metadata.databaseName || metadata.appId)})
        AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${sql(metadata.databaseUser || metadata.appId)}))::text`]);
    if (result.exitCode !== 0 || result.stdout.trim() !== 'true') throw new Error('Retained shared database is missing');
  }
  return { skipSecrets: true, skipDatabase: true, skipConfigFiles: true,
    sharedDatabaseCreated: metadata.databaseMode === 'shared' && metadata.sharedDatabaseCreated === true,
    retainedRuntimes: Object.fromEntries(metadata.retainedRoots!.roots.map(root =>
      [root.sourceName, { name: root.retainedName, ownerId: root.ownerId, pool: root.pool }])) };
}

async function cleanupAdoptedRoots(metadata: InstallMetadata) {
  for (const root of metadata.retainedRoots!.roots) await deleteRetainedRuntime(retainedBinding(metadata, root));
  await removeRetainedInstallMetadata(metadata.appId);
}

/** Persist consumption before cleanup; a failed write must not report success. */
export async function consumeRetainedRecovery(
  metadata: InstallMetadata,
  persist: (metadata: InstallMetadata) => Promise<void>,
  cleanup: (metadata: InstallMetadata) => Promise<void>,
): Promise<boolean> {
  const consumed = structuredClone(metadata);
  consumed.retainedRoots!.state = 'adopted';
  await persist(consumed);
  try {
    await cleanup(consumed);
    return true;
  } catch {
    return false;
  }
}

export async function finishRetainedAdoption(appId: string): Promise<boolean> {
  const metadata = await readRetainedInstallMetadata(appId);
  if (!metadata) throw new Error('Retained adoption lost its durable record');
  await verifyRecord(metadata, 'ready');
  // Mark consumed before cleanup: a interrupted cleanup cannot reuse an old root
  // on a later uninstall after users have written fresh data.
  return consumeRetainedRecovery(metadata, saveRetainedInstallMetadata, cleanupAdoptedRoots);
}

export async function verifyPreviouslyRetainedRoot(metadata: InstallMetadata, sourceName: string) {
  const retained = await readRetainedInstallMetadata(metadata.appId);
  if (!retained) throw new Error('Missing retained root recovery map');
  await verifyRecord(retained, 'retained');
  const root = retained.retainedRoots!.roots.find(r => r.sourceName === sourceName);
  if (!root || retained.installationId !== metadata.installationId) throw new Error('Missing retained root');
}
