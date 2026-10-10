import { incusRequest } from '../incus/server';
import type { AppManifest, InstallConfig, StorageVolumeMeta } from './types';
import { withAppLifecycle } from './update-admission';

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_POOL = 'default';

type IncusPool = {
  name: string;
  driver: string;
  status: string;
  description?: string;
  config?: Record<string, string>;
};

type IncusPoolResources = { space?: { total?: number; used?: number } };

type IncusCustomVolume = {
  name: string;
  type: 'custom';
  content_type: 'filesystem' | 'block' | 'iso';
  description?: string;
  config?: Record<string, string>;
  used_by?: string[];
};

export interface StorageLocation {
  id: string;
  name: string;
  driver: string;
  internal: boolean;
  availableBytes: number | null;
  totalBytes: number | null;
}

export interface PlannedStorageVolume extends StorageVolumeMeta {
  created: boolean;
}

export interface AppStorageStatus {
  available: boolean;
  detail: string;
  unavailable: Array<{ pool: string; volume: string; reason: 'pool-disconnected' | 'volume-missing' }>;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function assertName(value: string, label: string): void {
  if (!SAFE_NAME.test(value)) throw new Error(`${label} is invalid`);
}

async function waitForOperation(operation: string, seconds = 60): Promise<void> {
  const result = await incusRequest<Record<string, unknown>>(
    'GET',
    `${operation}/wait?timeout=${seconds}`,
    undefined,
    { timeout: (seconds + 10) * 1000 },
  );
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (result.type === 'error' || metadata?.status === 'Failure') {
    throw new Error('Incus storage operation failed');
  }
}

async function complete(result: Awaited<ReturnType<typeof incusRequest>>): Promise<void> {
  if (result.type === 'error') throw new Error('Incus storage operation failed');
  if (result.type === 'async' && result.operation) await waitForOperation(result.operation);
}

export function appVolumeName(appId: string, containerName: string, volumeName: string): string {
  for (const [value, label] of [[appId, 'App ID'], [containerName, 'Container name'], [volumeName, 'Volume name']] as const) {
    assertName(value, label);
  }
  const value = `ye-${appId}-${containerName}-${volumeName}`;
  if (value.length > 63) throw new Error('App storage volume name is too long');
  return value;
}

export function sharedVolumeName(group: string): string {
  assertName(group, 'Storage group');
  const value = `ye-shared-${group}`;
  if (value.length > 63) throw new Error('Shared storage volume name is too long');
  return value;
}

export async function listStorageLocations(): Promise<StorageLocation[]> {
  const response = await incusRequest<IncusPool[]>('GET', '/1.0/storage-pools?recursion=1');
  if (response.type === 'error' || !Array.isArray(response.metadata)) {
    throw new Error('Storage locations are unavailable');
  }
  const locations: StorageLocation[] = [];
  for (const pool of response.metadata) {
    if (!SAFE_NAME.test(pool.name) || pool.status !== 'Created') continue;
    if (pool.name !== DEFAULT_POOL && pool.config?.['user.youeye.app_storage'] !== 'true') continue;
    const resources = await incusRequest<IncusPoolResources>(
      'GET',
      `/1.0/storage-pools/${encode(pool.name)}/resources`,
    );
    // Incus retains the configured pool status as Created when removable ZFS
    // vdevs disappear. A real resources read is the non-mutating reachability
    // proof; do not offer a configured-but-disconnected pool for new data.
    if (resources.type === 'error') continue;
    const total = resources.metadata?.space?.total ?? null;
    const used = resources.metadata?.space?.used ?? null;
    locations.push({
      id: pool.name,
      name: pool.description?.trim() || (pool.name === DEFAULT_POOL ? 'Internal storage' : pool.name),
      driver: pool.driver,
      internal: pool.name === DEFAULT_POOL,
      availableBytes: total === null || used === null ? null : Math.max(0, total - used),
      totalBytes: total,
    });
  }
  return locations.sort((a, b) => Number(b.internal) - Number(a.internal) || a.name.localeCompare(b.name));
}

async function customVolume(pool: string, name: string): Promise<IncusCustomVolume | null> {
  const response = await incusRequest<IncusCustomVolume>(
    'GET',
    `/1.0/storage-pools/${encode(pool)}/volumes/custom/${encode(name)}`,
  );
  if (response.type === 'error' && (response.error_code === 404 || response.status_code === 404)) return null;
  if (response.type === 'error') throw new Error('Could not inspect app storage');
  return response.metadata;
}

async function findCustomVolume(name: string, pools: StorageLocation[]): Promise<{ pool: string; volume: IncusCustomVolume } | null> {
  const found: Array<{ pool: string; volume: IncusCustomVolume }> = [];
  for (const location of pools) {
    const volume = await customVolume(location.id, name);
    if (volume) found.push({ pool: location.id, volume });
  }
  if (found.length > 1) throw new Error('App storage identity is ambiguous across storage locations');
  return found[0] ?? null;
}

function assertOwnedVolume(volume: IncusCustomVolume, expected: Omit<StorageVolumeMeta, 'pool'>): void {
  const config = volume.config ?? {};
  if (volume.name !== expected.name || volume.type !== 'custom' || volume.content_type !== 'filesystem'
    || config['user.youeye.kind'] !== (expected.sharedGroup ? 'shared' : 'app')
    || (!expected.attachmentOnly && !expected.sharedGroup
      && (config['user.youeye.logical_name'] !== expected.logicalName
        || config['user.youeye.volume_type'] !== expected.type))
    || (expected.sharedGroup
      ? config['user.youeye.storage_group'] !== expected.sharedGroup
      : config['user.youeye.app_id'] !== expected.appId)) {
    throw new Error('Existing storage volume is not owned by this YouEye app');
  }
  if ((expected.installationId && config['user.youeye.installation_id'] !== expected.installationId)
    || (expected.dataOwnerId && config['user.youeye.data_owner_id'] !== expected.dataOwnerId)
    || (expected.shareId && config['user.youeye.share_id'] !== expected.shareId)) {
    throw new Error('Existing storage volume has foreign or unresolved household ownership');
  }
}

export async function bindSharedVolumeOwnership(volume: StorageVolumeMeta, shareId: string, ownerId: string) {
  if (!volume.sharedGroup) throw new Error('Shared ownership requires an explicit storage group');
  const current = await customVolume(volume.pool, volume.name);
  if (!current) throw new Error('Shared persistent volume is unavailable');
  assertOwnedVolume(current, { ...volume, installationId: undefined, shareId: undefined, dataOwnerId: undefined });
  const config = current.config || {};
  if ((config['user.youeye.share_id'] && config['user.youeye.share_id'] !== shareId)
    || (config['user.youeye.data_owner_id'] && config['user.youeye.data_owner_id'] !== ownerId)) {
    throw new Error('Shared volume has foreign stable ownership');
  }
  if (!config['user.youeye.share_id'] || !config['user.youeye.data_owner_id']) {
    await complete(await incusRequest('PUT',
      `/1.0/storage-pools/${encode(volume.pool)}/volumes/custom/${encode(volume.name)}`, {
        description: current.description || '', config: { ...config,
          'user.youeye.share_id': shareId, 'user.youeye.data_owner_id': ownerId },
      }));
  }
  const updated = await customVolume(volume.pool, volume.name);
  if (!updated) throw new Error('Shared owned volume did not read back');
  assertOwnedVolume(updated, { ...volume, shareId, dataOwnerId: ownerId });
  volume.shareId = shareId;
  volume.dataOwnerId = ownerId;
}

/** Additive v1 baseline only after exact old app/logical-volume checks. */
export async function bindAppVolumeOwnership(volume: StorageVolumeMeta, installationId: string, ownerId: string) {
  if (volume.sharedGroup) throw new Error('Shared storage needs an explicit stable share declaration');
  const current = await customVolume(volume.pool, volume.name);
  if (!current) throw new Error('Persistent volume is unavailable');
  assertOwnedVolume(current, { ...volume, installationId: undefined, dataOwnerId: undefined });
  const config = current.config || {};
  const oldInstallation = config['user.youeye.installation_id'];
  const oldOwner = config['user.youeye.data_owner_id'];
  if ((oldInstallation && oldInstallation !== installationId) || (oldOwner && oldOwner !== ownerId)) {
    throw new Error('Persistent volume belongs to a different installation or data owner');
  }
  if (!oldInstallation || !oldOwner) {
    await complete(await incusRequest('PUT',
      `/1.0/storage-pools/${encode(volume.pool)}/volumes/custom/${encode(volume.name)}`, {
        description: current.description || '', config: { ...config,
          'user.youeye.installation_id': installationId, 'user.youeye.data_owner_id': ownerId },
      }));
  }
  const updated = await customVolume(volume.pool, volume.name);
  if (!updated) throw new Error('Owned volume did not read back');
  assertOwnedVolume(updated, { ...volume, installationId, dataOwnerId: ownerId });
  volume.installationId = installationId;
  volume.dataOwnerId = ownerId;
}

function selectedPool(config: InstallConfig, type: StorageVolumeMeta['type']): string {
  return config.storage?.placements?.[type] || config.storage?.pool || DEFAULT_POOL;
}

export async function ensureAppStorage(
  manifest: AppManifest,
  config: InstallConfig,
): Promise<PlannedStorageVolume[]> {
  return withAppLifecycle(manifest.metadata.id, () => ensureAppStorageLocked(manifest, config));
}

async function ensureAppStorageLocked(
  manifest: AppManifest,
  config: InstallConfig,
): Promise<PlannedStorageVolume[]> {
  const locations = await listStorageLocations();
  if (locations.length === 0) throw new Error('No eligible app storage location is available');
  const locationIds = new Set(locations.map((location) => location.id));
  const planned: PlannedStorageVolume[] = [];

  for (const container of manifest.containers) {
    const runtimeName = manifest.containers.length === 1
      ? `app-${manifest.metadata.id}`
      : `app-${manifest.metadata.id}-${container.name}`;
    for (const volume of container.volumes) {
      if (volume.type === 'cache') continue;
      if (volume.sourceVolume) continue;
      const name = volume.storageGroup
        ? sharedVolumeName(volume.storageGroup)
        : appVolumeName(manifest.metadata.id, container.name, volume.name);
      const expected: Omit<StorageVolumeMeta, 'pool'> = {
        appId: manifest.metadata.id,
        installationId: volume.storageGroup ? undefined : config.admissionInstallationId,
        dataOwnerId: volume.storageGroup ? undefined : config.admissionResourceOwners?.[name] || config.admissionDataOwnerId,
        name,
        logicalName: volume.name,
        containerName: runtimeName,
        containerPath: volume.container,
        type: volume.type,
        sharedGroup: volume.storageGroup,
        readOnly: volume.read_only,
        backup: true,
      };
      const existing = await findCustomVolume(name, locations);
      if (existing) {
        assertOwnedVolume(existing.volume, expected);
        planned.push({ ...expected, pool: existing.pool, created: false });
        continue;
      }
      const pool = selectedPool(config, volume.type);
      if (!locationIds.has(pool)) throw new Error('Selected storage location is unavailable');
      const create = await incusRequest(
        'POST',
        `/1.0/storage-pools/${encode(pool)}/volumes/custom`,
        {
          name,
          type: 'custom',
          content_type: 'filesystem',
          description: volume.storageGroup
            ? `YouEye shared ${volume.storageGroup} storage`
            : `YouEye ${manifest.metadata.name} ${volume.name} storage`,
          config: {
            'initial.mode': '0777',
            'security.shifted': 'true',
            'user.youeye.kind': volume.storageGroup ? 'shared' : 'app',
            'user.youeye.app_id': volume.storageGroup ? '' : manifest.metadata.id,
            'user.youeye.logical_name': volume.name,
            'user.youeye.volume_type': volume.type,
            'user.youeye.storage_group': volume.storageGroup ?? '',
            'user.youeye.backup': 'true',
            ...(expected.installationId ? { 'user.youeye.installation_id': expected.installationId } : {}),
            ...(expected.dataOwnerId ? { 'user.youeye.data_owner_id': expected.dataOwnerId } : {}),
          },
        },
      );
      await complete(create);
      const readBack = await customVolume(pool, name);
      if (!readBack) throw new Error('Created app storage did not read back');
      assertOwnedVolume(readBack, expected);
      planned.push({ ...expected, pool, created: true });
    }
    for (const volume of container.volumes.filter((candidate) => candidate.sourceVolume)) {
      const source = planned.find((candidate) =>
        candidate.containerName === runtimeName && candidate.logicalName === volume.sourceVolume
      );
      if (!source || !volume.sourcePath) throw new Error('App storage subpath references an unknown volume');
      planned.push({
        ...source,
        logicalName: volume.name,
        containerPath: volume.container,
        type: volume.type === 'cache' ? source.type : volume.type,
        readOnly: volume.read_only,
        sourcePath: volume.sourcePath,
        attachmentOnly: true,
        created: false,
      });
    }
  }
  return planned;
}

/** Offline retained consumers still own shared data even with no mounted instance. */
export async function hasOtherShareConsumers(volume: Pick<StorageVolumeMeta, 'appId' | 'shareId' | 'sharedGroup'>) {
  if (!volume.sharedGroup) return false;
  if (!volume.shareId) throw new Error('Shared data has unresolved ownership');
  const { identityRows, identitySql } = await import('@/lib/identity/store');
  const consumers = await identityRows(`SELECT 1 FROM admission_resources r
    JOIN admission_policies p USING (installation_id)
    WHERE r.declaration->>'shareId' = ${identitySql(volume.shareId)}
      AND r.state <> 'deleted' AND p.app_id <> ${identitySql(volume.appId)} LIMIT 1`);
  return consumers.length > 0;
}

export async function deleteAppStorage(
  volumes: StorageVolumeMeta[],
  options: { onlyCreated?: Set<string> } = {},
): Promise<void> {
  const appIds = [...new Set(volumes.map(volume => volume.appId))].sort();
  const admit = (index: number): Promise<void> => {
    if (index === appIds.length) return deleteAppStorageLocked(volumes, options);
    const appId = appIds[index];
    return withAppLifecycle(appId, () => admit(index + 1), {
      resources: volumes.filter(volume => volume.appId === appId).map(volume => ({
        kind: 'volume', scope: volume.pool, name: volume.name, ownerAppId: appId, mutable: true,
      })),
    });
  };
  return admit(0);
}

async function deleteAppStorageLocked(
  volumes: StorageVolumeMeta[],
  options: { onlyCreated?: Set<string> },
): Promise<void> {
  const unique = new Map(volumes.filter(v => !v.attachmentOnly).map((volume) => [`${volume.pool}/${volume.name}`, volume]));
  for (const [key, volume] of unique) {
    if (options.onlyCreated && !options.onlyCreated.has(key)) continue;
    const current = await customVolume(volume.pool, volume.name);
    if (!current) continue;
    if (!volume.dataOwnerId || (volume.sharedGroup ? !volume.shareId : !volume.installationId)) {
      throw new Error('Storage cleanup requires resolved installation and data ownership');
    }
    assertOwnedVolume(current, volume);
    if (volume.sharedGroup && await hasOtherShareConsumers(volume)) continue;
    if ((current.used_by?.length ?? 0) > 0) {
      if (volume.sharedGroup) continue;
      throw new Error('App storage is still attached to a container');
    }
    await complete(await incusRequest(
      'DELETE',
      `/1.0/storage-pools/${encode(volume.pool)}/volumes/custom/${encode(volume.name)}`,
    ));
    if (await customVolume(volume.pool, volume.name)) throw new Error('App storage remained after deletion');
  }
}

/** Check all ownership before uninstall starts changing containers or databases. */
export async function verifyAppStorageOwnership(volumes: StorageVolumeMeta[]): Promise<void> {
  for (const volume of volumes.filter(v => !v.attachmentOnly)) {
    if (!volume.dataOwnerId || (volume.sharedGroup ? !volume.shareId : !volume.installationId)) {
      throw new Error('Storage cleanup requires resolved installation and data ownership');
    }
    const current = await customVolume(volume.pool, volume.name);
    if (current) assertOwnedVolume(current, volume);
  }
}

export async function verifyAppStorageRemoval(volumes: StorageVolumeMeta[]): Promise<boolean> {
  const unique = new Map(
    volumes
      .filter((volume) => !volume.attachmentOnly)
      .map((volume) => [`${volume.pool}/${volume.name}`, volume]),
  );
  for (const volume of unique.values()) {
    const current = await customVolume(volume.pool, volume.name);
    if (!current) continue;
    assertOwnedVolume(current, volume);
    if (volume.sharedGroup && ((current.used_by?.length ?? 0) > 0 || await hasOtherShareConsumers(volume))) continue;
    return false;
  }
  return true;
}

export async function deleteCreatedRecoveryStorage(
  appId: string,
  refs: Array<{ pool: string; name: string }>,
): Promise<void> {
  return withAppLifecycle(appId, () => deleteCreatedRecoveryStorageLocked(appId, refs), {
    resources: refs.map(ref => ({
      kind: 'volume', scope: ref.pool, name: ref.name, ownerAppId: appId, mutable: true,
    })),
  });
}

async function deleteCreatedRecoveryStorageLocked(
  appId: string,
  refs: Array<{ pool: string; name: string }>,
): Promise<void> {
  assertName(appId, 'App ID');
  for (const ref of refs) {
    assertName(ref.pool, 'Storage pool');
    assertName(ref.name, 'Storage volume');
    const current = await customVolume(ref.pool, ref.name);
    if (!current) continue;
    const config = current.config ?? {};
    const kind = config['user.youeye.kind'];
    if ((kind === 'app' && config['user.youeye.app_id'] !== appId)
      || (kind !== 'app' && kind !== 'shared')) {
      throw new Error('Recovery storage is not owned by this YouEye app');
    }
    if ((current.used_by?.length ?? 0) > 0) throw new Error('Recovery storage is still attached to an instance');
    await complete(await incusRequest(
      'DELETE',
      `/1.0/storage-pools/${encode(ref.pool)}/volumes/custom/${encode(ref.name)}`,
    ));
  }
}

export function volumesForContainer(
  volumes: StorageVolumeMeta[],
  containerName: string,
): StorageVolumeMeta[] {
  return volumes.filter((volume) => volume.containerName === containerName);
}

/**
 * Verify that every durable volume recorded for an app is still reachable.
 * This is intentionally read-only: an unplugged drive must never cause YouEye
 * to recreate an empty replacement volume on another pool.
 */
export async function inspectAppStorage(volumes: StorageVolumeMeta[] = []): Promise<AppStorageStatus> {
  const durable = new Map(
    volumes
      .filter((volume) => !volume.attachmentOnly)
      .map((volume) => [`${volume.pool}/${volume.name}`, volume]),
  );
  const unavailable: AppStorageStatus['unavailable'] = [];
  const poolState = new Map<string, boolean>();

  for (const volume of durable.values()) {
    let poolAvailable = poolState.get(volume.pool);
    if (poolAvailable === undefined) {
      const pool = await incusRequest<IncusPool>('GET', `/1.0/storage-pools/${encode(volume.pool)}`);
      poolAvailable = pool.type !== 'error' && pool.metadata?.status === 'Created';
      if (poolAvailable) {
        const resources = await incusRequest<IncusPoolResources>(
          'GET',
          `/1.0/storage-pools/${encode(volume.pool)}/resources`,
        );
        poolAvailable = resources.type !== 'error';
      }
      poolState.set(volume.pool, poolAvailable);
    }
    if (!poolAvailable) {
      unavailable.push({ pool: volume.pool, volume: volume.name, reason: 'pool-disconnected' });
      continue;
    }
    if (!await customVolume(volume.pool, volume.name)) {
      unavailable.push({ pool: volume.pool, volume: volume.name, reason: 'volume-missing' });
    }
  }

  if (unavailable.length === 0) {
    return { available: true, detail: 'App storage is connected', unavailable };
  }
  const first = unavailable[0];
  const reason = first.reason === 'pool-disconnected'
    ? `storage location ${first.pool} is disconnected`
    : `storage volume ${first.volume} is missing from ${first.pool}`;
  return {
    available: false,
    detail: `App storage unavailable: ${reason}`,
    unavailable,
  };
}
