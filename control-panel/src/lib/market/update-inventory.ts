import type { AppManifest, InstallMetadata, StorageVolumeMeta } from './types';
import { updateResourceKey, type UpdateResource } from './update-journal';

/**
 * Provider observations are inputs, never inferred from a manifest declaration.
 * The caller must read them under lifecycle exclusion and revalidate before effects.
 */
export interface UpdateInventoryObservations {
  containers: Array<{
    name: string;
    ownerAppId: string;
    state: 'Running' | 'Stopped';
    rootPool: string;
    oldRuntimeAvailable: boolean;
    restoreSupported: boolean;
    /** Actual expanded disk attachments, excluding root. */
    volumes: Array<{ pool: string; name: string; readOnly: boolean; containerPath?: string; sourcePath?: string }>;
  }>;
  volumes: Array<{
    pool: string;
    name: string;
    ownerAppId?: string;
    sharedGroup?: string;
    contentType: string;
    snapshotSupported: boolean;
    /** Exact Incus used_by identities. Unknown/non-instance users fail closed. */
    users: string[];
  }>;
  databases: Array<{
    engine: string;
    name: string;
    ownerAppId: string;
    ownerRole: string;
    writers: string[];
    logicalRestoreSupported: boolean;
  }>;
  pools: Array<{ name: string; availableBytes: number; checkpointBytes: number; cleanupReserveBytes: number }>;
}

export interface AppUpdateInventory {
  resources: UpdateResource[];
  originalRunning: Record<string, boolean>;
  volumes: Array<{ pool: string; name: string; readOnly: boolean }>;
  databases: Array<{ engine: string; name: string; ownerRole: string; mode: 'shared' | 'own' }>;
}

export class AppUpdatePreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AppUpdatePreflightError';
  }
}

function reject(code: string, message: string): never {
  throw new AppUpdatePreflightError(code, message);
}

function resolved(value: string | undefined, appId: string): string {
  const result = (value ?? '').replaceAll('${app.id}', appId).replaceAll('${app.name}', appId);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(result)) {
    reject('unknown-resource-identity', 'Update resource identity is missing or unresolved.');
  }
  return result;
}

function volumeIdentity(volume: Pick<StorageVolumeMeta, 'pool' | 'name'>): string {
  return JSON.stringify([volume.pool, volume.name]);
}

function databaseDeclaration(manifest: AppManifest, metadata: InstallMetadata) {
  const appId = metadata.appId;
  const mode = manifest.database?.mode ?? 'none';
  if (mode === 'none') return undefined;
  if (mode === 'shared') {
    return {
      mode, engine: 'youeye-postgres',
      name: resolved(manifest.database?.name, appId),
      ownerRole: resolved(manifest.database?.user, appId),
    } as const;
  }
  const own = manifest.backup?.ownPostgres;
  if (!own) reject('own-postgres-recovery-undeclared',
    'This app must declare its dedicated PostgreSQL database and logical recovery method before updating.');
  const engine = resolved(own.container, appId);
  if (!metadata.containers.some(c => c.containerName === engine && c.role === 'database'
    && c.name === manifest.database?.container)) {
    reject('foreign-database-engine', 'The PostgreSQL engine is not an app-owned database container.');
  }
  return { mode, engine, name: resolved(own.database, appId),
    ownerRole: resolved(own.user ?? own.database, appId) } as const;
}

/**
 * Finite v1: all mutable resources must belong to this app, with every observed
 * writer in its container closure. A writable shared group is unsupported.
 * Read-only shared inputs are admitted only when their definition is unchanged.
 */
export function planAppUpdateInventory(
  metadata: InstallMetadata,
  oldManifest: AppManifest,
  targetManifest: AppManifest,
  observed: UpdateInventoryObservations,
): AppUpdateInventory {
  const appId = metadata.appId;
  if (oldManifest.metadata.id !== appId || targetManifest.metadata.id !== appId) {
    reject('manifest-app-mismatch', 'Installed and target manifests must identify the same app.');
  }
  if (metadata.lifecycleState === 'installing') {
    reject('install-incomplete', 'Finish or recover the current installation before updating.');
  }
  const expectedNames = new Set(metadata.containers.map(c => c.containerName));
  if (expectedNames.size !== metadata.containers.length || expectedNames.size === 0) {
    reject('unknown-container-identity', 'Installed container identities are incomplete or duplicated.');
  }
  for (const manifest of [oldManifest, targetManifest]) {
    if (manifest.containers.length !== metadata.containers.length
      || manifest.containers.some(c => !metadata.containers.some(
        m => m.name === c.name && m.type === c.type,
      ))) {
      reject('unsupported-runtime-topology-change',
        'This update changes the app container topology. A compatible recovery declaration is required.');
    }
  }
  const storageDefinition = (manifest: AppManifest) => JSON.stringify(manifest.containers.map(c =>
    ({ name: c.name, volumes: c.volumes })));
  if (storageDefinition(oldManifest) !== storageDefinition(targetManifest)) {
    reject('unsupported-storage-topology-change',
      'This update changes storage attachments. A compatible scoped recovery declaration is required.');
  }
  const resources: UpdateResource[] = [
    { kind: 'app', scope: 'market', name: appId, ownerAppId: appId, mutable: false },
    // One scoped checkpoint contains install/provenance/manifest/route references
    // and current security revision references, never global accounts or policy.
    { kind: 'metadata', scope: 'market', name: appId, ownerAppId: appId, mutable: true },
  ];
  const originalRunning: Record<string, boolean> = {};
  const actualContainers = new Map(observed.containers.map(c => [c.name, c]));
  if (actualContainers.size !== observed.containers.length) {
    reject('ambiguous-container-identity', 'Container observations contain duplicate identities.');
  }
  for (const name of [...expectedNames].sort()) {
    const actual = actualContainers.get(name);
    if (!actual || actual.ownerAppId !== appId) {
      reject('foreign-or-missing-container', 'An update container is missing or its ownership cannot be proven.');
    }
    if (!['Running', 'Stopped'].includes(actual.state)) {
      reject('unknown-container-state', 'An update container has an unsupported runtime state.');
    }
    if (!actual.oldRuntimeAvailable || !actual.restoreSupported) {
      reject('old-runtime-unavailable', 'The installed runtime cannot be restored. No update hooks were run.');
    }
    originalRunning[name] = actual.state === 'Running';
    resources.push({ kind: 'container', scope: 'incus', name, ownerAppId: appId, mutable: true });
  }

  const declaredVolumes = metadata.storageVolumes ?? [];
  for (const container of oldManifest.containers) {
    const runtime = metadata.containers.find(c => c.name === container.name)!;
    for (const volume of container.volumes) {
      if (volume.type === 'cache' && !volume.sourceVolume) continue;
      const declarations = declaredVolumes.filter(v => v.containerName === runtime.containerName
        && v.logicalName === volume.name);
      const sharedGroup = volume.storageGroup ?? (volume.sourceVolume
        ? container.volumes.find(v => v.name === volume.sourceVolume)?.storageGroup : undefined);
      if (declarations.length !== 1
        || declarations[0].containerPath !== volume.container
        || declarations[0].readOnly !== volume.read_only
        || declarations[0].sharedGroup !== sharedGroup
        || declarations[0].sourcePath !== volume.sourcePath) {
        reject('missing-declared-storage', 'Frozen manifest storage does not match the recorded install attachments.');
      }
    }
  }
  const volumes = new Map<string, { pool: string; name: string; readOnly: boolean }>();
  for (const declared of declaredVolumes) {
    if (declared.appId !== appId || !expectedNames.has(declared.containerName)) {
      reject('foreign-volume-declaration', 'A recorded storage attachment belongs to another app or container.');
    }
    const key = volumeIdentity(declared);
    const existing = volumes.get(key);
    volumes.set(key, { pool: declared.pool, name: declared.name,
      readOnly: declared.readOnly && (existing?.readOnly ?? true) });
  }
  // Do not discard subpath aliases: a read-only base with a writable alias is
  // mutable, and the complete backing volume needs one recovery point.
  for (const name of expectedNames) {
    for (const attachment of actualContainers.get(name)!.volumes) {
      const declarations = declaredVolumes.filter(v => v.containerName === name
        && volumeIdentity(v) === volumeIdentity(attachment));
      if (declarations.length === 0
        || (attachment.containerPath !== undefined
          ? !declarations.some(v => v.containerPath === attachment.containerPath
            && v.sourcePath === attachment.sourcePath && v.readOnly === attachment.readOnly)
          : attachment.readOnly !== declarations.every(v => v.readOnly))) {
        reject('unknown-mutable-volume', 'An actual storage attachment is absent from the frozen install inventory.');
      }
    }
    for (const declared of declaredVolumes.filter(v => v.containerName === name)) {
      if (!actualContainers.get(name)!.volumes.some(v => volumeIdentity(v) === volumeIdentity(declared)
        && (v.containerPath === undefined || (v.containerPath === declared.containerPath
          && v.sourcePath === declared.sourcePath && v.readOnly === declared.readOnly)))) {
        reject('missing-volume-attachment', 'A recorded storage volume is no longer attached to its container.');
      }
    }
  }

  for (const volume of volumes.values()) {
    const matches = observed.volumes.filter(v => volumeIdentity(v) === volumeIdentity(volume));
    if (matches.length !== 1 || matches[0].contentType !== 'filesystem') {
      reject('missing-or-ambiguous-volume', 'A recovery volume is missing or its identity is ambiguous.');
    }
    const actual = matches[0];
    const declarations = declaredVolumes.filter(v => volumeIdentity(v) === volumeIdentity(volume));
    const sharedGroups = new Set(declarations.map(v => v.sharedGroup ?? ''));
    if (sharedGroups.size !== 1) reject('ambiguous-volume-owner', 'Storage declarations disagree on volume ownership.');
    const sharedGroup = declarations[0].sharedGroup;
    if (sharedGroup ? actual.sharedGroup !== sharedGroup : actual.ownerAppId !== appId) {
      reject('foreign-volume', 'Incus ownership does not match the recorded storage volume.');
    }
    if (!volume.readOnly && (sharedGroup || actual.users.some(user => !expectedNames.has(user)))) {
      reject('unsupported-shared-resource',
        'This app writes shared storage. Version 1 requires a recovery contract covering every writer before update.');
    }
    if (!volume.readOnly && !actual.snapshotSupported) {
      reject('volume-recovery-unavailable', 'The app storage location does not support a verified restore point.');
    }
    if (volume.readOnly && sharedGroup) {
      const definitions = (manifest: AppManifest) => JSON.stringify(manifest.containers.map(c =>
        ({ name: c.name, volumes: c.volumes.filter(v => v.storageGroup === sharedGroup) })));
      if (definitions(oldManifest) !== definitions(targetManifest)) {
        reject('shared-input-definition-changed', 'A read-only shared input changes definition during this update.');
      }
    }
    resources.push({ kind: 'volume', scope: volume.pool, name: volume.name,
      ownerAppId: appId, mutable: !volume.readOnly });
  }
  const beforeDb = databaseDeclaration(oldManifest, metadata);
  const afterDb = databaseDeclaration(targetManifest, metadata);
  if (JSON.stringify(beforeDb) !== JSON.stringify(afterDb)
    || (metadata.databaseMode ?? 'none') !== (oldManifest.database?.mode ?? 'none')) {
    reject('unsupported-database-topology-change', 'The database ownership or recovery mode changes during this update.');
  }
  const databases: AppUpdateInventory['databases'] = [];
  if (beforeDb) {
    if (['postgres', 'template0', 'template1', 'youeye', 'youeye_ui', 'pointer'].includes(beforeDb.name)) {
      reject('platform-database-excluded', 'An application update cannot restore a platform or maintenance database.');
    }
    const matches = observed.databases.filter(d => d.engine === beforeDb.engine && d.name === beforeDb.name);
    if (matches.length !== 1 || matches[0].ownerAppId !== appId
      || matches[0].ownerRole !== beforeDb.ownerRole) {
      reject('foreign-or-unknown-database', 'Dedicated PostgreSQL ownership cannot be verified for this app.');
    }
    const actual = matches[0];
    if (beforeDb.mode === 'shared'
      && (metadata.databaseName !== beforeDb.name || metadata.databaseUser !== beforeDb.ownerRole)) {
      reject('unknown-database-identity', 'Installed database identity disagrees with the frozen manifest.');
    }
    if (!actual.logicalRestoreSupported) {
      reject('database-recovery-unavailable', 'A verified scoped logical PostgreSQL restore is required before update.');
    }
    if (actual.writers.some(writer => !expectedNames.has(writer))) {
      reject('unsupported-shared-resource', 'The app database has writers outside the app recovery boundary.');
    }
    databases.push(beforeDb);
    resources.push({ kind: 'database', scope: beforeDb.engine, name: beforeDb.name,
      ownerAppId: appId, mutable: true });
    if (beforeDb.mode === 'own') {
      // PostgreSQL-owned disks are reserved but recovered logically. Rewinding
      // a raw cluster could resurrect role revocations or cross runtime versions.
      // The dedicated DB's logical checkpoint is the recovery authority.
      const engineVolumes = declaredVolumes.filter(v => v.containerName === beforeDb.engine);
      if (!engineVolumes.length) reject('own-postgres-storage-undeclared',
        'App-owned PostgreSQL must keep its database files in declared durable storage.');
      for (const resource of resources.filter(r => r.kind === 'volume')) {
        if (engineVolumes.some(v => v.pool === resource.scope && v.name === resource.name)) {
          if (declaredVolumes.some(v => v.pool === resource.scope && v.name === resource.name
            && v.containerName !== beforeDb.engine)) {
            reject('unsupported-shared-resource', 'PostgreSQL data storage cannot also be an application-writable mount.');
          }
          resource.mutable = false;
        }
      }
    }
  }
  const affectedPools = new Set([
    ...[...expectedNames].map(name => actualContainers.get(name)!.rootPool),
    ...[...volumes.values()].filter(v => !v.readOnly).map(v => v.pool),
  ]);
  for (const pool of affectedPools) {
    const matches = observed.pools.filter(p => p.name === pool);
    const capacity = matches[0];
    if (matches.length !== 1 || !capacity
      || ![capacity.availableBytes, capacity.checkpointBytes, capacity.cleanupReserveBytes]
        .every(n => Number.isSafeInteger(n) && n >= 0)
      || capacity.cleanupReserveBytes === 0
      || capacity.availableBytes < capacity.checkpointBytes + capacity.cleanupReserveBytes) {
      reject('insufficient-recovery-capacity', 'App storage lacks a verified checkpoint and cleanup reserve.');
    }
    resources.push({ kind: 'capacity', scope: 'incus-pool', name: pool, ownerAppId: appId, mutable: false });
  }
  // Finite v1 serializes the shared protected workspace budget. Concurrent
  // updates must not each spend the same measured free capacity.
  resources.push({ kind: 'capacity', scope: 'control-state', name: 'app-updates', ownerAppId: appId, mutable: false });
  return { resources: resources.sort((a, b) => updateResourceKey(a).localeCompare(updateResourceKey(b))),
    originalRunning, volumes: [...volumes.values()], databases };
}
