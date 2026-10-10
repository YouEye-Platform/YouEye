import { rm, readdir, lstat, readFile, statfs } from 'node:fs/promises';
import { incusRequest, execCommand, incusDownloadFile, incusUploadFile } from '@/lib/incus/server';
import {
  containerState, stopContainer, startContainer, waitForRunning, waitForContainerExec,
  deleteInstance, waitForOperation,
  buildRollbackCopyRequest,
} from '@/lib/incus/snapshot';
import { getConfig, setConfig } from '@/lib/caddy/client';
import { readInstallMetadata, saveInstallMetadata, listInstalledApps } from './metadata';
import { appServiceCredentials } from '../apps/service-credential-store';
import { getAdmissionSnapshot } from '../admission/store';
import { identityRows, identitySql } from '../identity/store';
import { getInstalledApp, restoreInstalledAppUpdateState, type InstalledAppUpdateState } from './installed-apps';
import { syncAppManifestObjectToUI } from './ui-manifest-sync';
import { readFrozenUpdateManifest } from './frozen-manifest';
export { readFrozenUpdateManifest } from './frozen-manifest';
import type { AppManifest, InstallMetadata, VariableContext } from './types';
import { writeAllConfigFiles } from './config-writer';
import { envToString } from './platform-env';
import { isManagedTrustMount } from './caddy-ca';
import { updateConfigurationContext, updateEnvironment, resolveUpdateTemplate } from './update-configuration';
import {
  planAppUpdateInventory, AppUpdatePreflightError, type AppUpdateInventory,
  type UpdateInventoryObservations,
} from './update-inventory';
import { updateResourceKey, type AppUpdateRecord, type UpdateResource, type UpdateCheckpoint } from './update-journal';
import type { AppUpdateProvider } from './update-transaction';
import { AppUpdateWorkspace, updateDigest } from './update-workspace';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import {
  createAppUpdatePostgresProvider, incusAppUpdatePostgresIO,
  type AppUpdatePostgresFence, type AppUpdatePostgresCheckpoint, type AppUpdatePostgresScope,
  type AppUpdatePostgresSecurity,
  type AppUpdatePostgresStaging,
} from './update-postgres';

type Instance = {
  name: string; config: Record<string, string>; devices: Record<string, Record<string, string>>;
  expanded_devices: Record<string, Record<string, string>>; profiles: string[];
};
type Volume = { name: string; config: Record<string, string>; content_type: string; used_by: string[]; description?: string };
type RecoveryPlan = {
  metadata: InstallMetadata; installed: InstalledAppUpdateState; manifest: AppManifest;
  inventory: AppUpdateInventory; instances: Instance[];
  postgres?: AppUpdatePostgresScope;
  securityRevision: string;
  capacity: { pools: Array<{ name: string; requiredBytes: number }>; stateBytes: number };
  volumeDescriptions: Array<{ pool: string; name: string; description: string }>;
};
function code(code: string, message: string): never { throw new AppUpdatePreflightError(code, message); }
async function read<T>(url: string): Promise<T> {
  const response = await incusRequest<T>('GET', url);
  if (response.type === 'error' || !response.metadata) throw new Error('App update provider inspection failed');
  return response.metadata;
}
async function optionalInstance(name: string): Promise<Instance | null> {
  const response = await incusRequest<Instance>('GET', `/1.0/instances/${e(name)}`);
  if (response.type === 'error' && (response.error_code === 404 || response.status_code === 404)) return null;
  if (response.type === 'error' || !response.metadata) throw new Error('App runtime inspection failed');
  return response.metadata;
}
async function effect(method: 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) {
  const result = await incusRequest(method, url, body, { timeout: 660_000 });
  if (result.type === 'error') throw new Error('App update provider operation failed');
  if (result.type === 'async' && result.operation) await waitForOperation(result.operation, 600);
}
const e = encodeURIComponent;
function volumeURL(pool: string, name: string) { return `/1.0/storage-pools/${e(pool)}/volumes/custom/${e(name)}`; }
function runtimeReference(record: AppUpdateRecord, index: number) {
  return `ye-rollback-${record.id.replaceAll('-', '').slice(0, 12)}-${index}`;
}
function pointName(record: AppUpdateRecord) { return `update-${record.id}`; }
function isolatedRecoveryDevices(instance: Instance): Instance['devices'] {
  const devices = structuredClone(instance.devices);
  for (const [name, device] of Object.entries(instance.expanded_devices)) {
    if (device.type === 'nic' || device.type === 'proxy') devices[name] = { type: 'none' };
  }
  return devices;
}
function stateOf(app: NonNullable<Awaited<ReturnType<typeof getInstalledApp>>>): InstalledAppUpdateState {
  const { installedVersion, catalogVersion, updateAvailable, switchPending, installedTag, installedBranch,
    channelSource, candidateVersion, candidateBranch, candidateTag } = app;
  return { installedVersion, catalogVersion, updateAvailable, switchPending, installedTag, installedBranch,
    channelSource, candidateVersion, candidateBranch, candidateTag };
}
const updateOwnedFields = new Set(['installedVersion', 'catalogKey', 'itemKind', 'sourceId', 'sourceName',
  'sourceRepoUrl', 'manifestSource', 'manifestPath', 'manifestRepo', 'manifestBranch', 'manifestDigest',
  'nativeArtifacts', 'containers', 'entrances', 'appliedMigrations']);
function stable(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}
async function securityRevision(metadata: InstallMetadata): Promise<string> {
  const policy = Object.fromEntries(Object.entries(metadata).filter(([key]) => !updateOwnedFields.has(key)));
  const files: Array<[string, string]> = [];
  const dir = `/var/lib/youeye/app-${metadata.appId}`;
  for (const name of (await readdir(dir)).sort()) {
    if (name === 'install.json' || name.startsWith('.install-')) continue;
    const file = `${dir}/${name}`;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      code('unknown-security-state', 'App security files require bounded regular-file recovery metadata.');
    }
    files.push([name, updateDigest(await readFile(file))]);
  }
  const credential = await appServiceCredentials.projection(metadata.appId);
  const admission = await getAdmissionSnapshot(metadata.appId);
  if (!credential || !admission) code('unknown-security-state', 'App credential and ownership authority must be available.');
  const resources = await identityRows(`SELECT r.resource_id, r.declaration, r.owner_id, r.private_user_id, r.state
    FROM admission_resources r JOIN admission_policies p USING (installation_id)
    WHERE p.app_id = ${identitySql(metadata.appId)} ORDER BY r.resource_id`);
  // Authority is outside container/volume checkpoints. Observe its complete
  // generation and revocation state before any old application data can reopen.
  return updateDigest(stable([policy, files, credential, admission.policy, [...admission.principals].sort((a, b) => a.id.localeCompare(b.id)), resources]));
}
function postgresScope(metadata: InstallMetadata, manifest: AppManifest): AppUpdatePostgresScope | undefined {
  if (!manifest.database || manifest.database.mode === 'none') return undefined;
  const own = manifest.backup?.ownPostgres;
  const resolve = (value: string | undefined) => {
    if (!value) code('unknown-database-identity', 'A database resource identity is missing.');
    return value.replaceAll('${app.id}', metadata.appId).replaceAll('${app.name}', metadata.appId);
  };
  if (manifest.database.mode === 'own' && !own) code('own-postgres-recovery-undeclared', 'Declare an app-owned logical PostgreSQL recovery method.');
  return {
    appId: metadata.appId, mode: manifest.database.mode,
    engine: manifest.database.mode === 'shared' ? 'youeye-postgres' : resolve(own!.container),
    database: resolve(manifest.database.mode === 'shared' ? manifest.database.name : own!.database),
    ownerRole: resolve(manifest.database.mode === 'shared' ? manifest.database.user : (own!.user ?? own!.database)),
    adminRole: manifest.database.mode === 'shared' ? 'youeye' : 'postgres',
    adminRoles: manifest.database.mode === 'shared' ? ['youeye', 'postgres'] : ['postgres'],
    maxDumpBytes: 64 * 1024 * 1024,
  };
}
async function postgresProvider(
  scope: AppUpdatePostgresScope, metadata: InstallMetadata, ingressBlocked: boolean,
  persistStaging?: (receipt: AppUpdatePostgresStaging) => Promise<void>,
) {
  const io = incusAppUpdatePostgresIO(async () => {
    const current = await readInstallMetadata(metadata.appId);
    if (!current) throw new Error('App security metadata is unavailable');
    const credentialUses = [];
    for (const app of await listInstalledApps()) {
      // Include the entire recorded credential closure, even stopped workloads.
      if (app.databaseMode === 'none') continue;
      const manifest = await readFrozenUpdateManifest(app.appId, app.installedVersion);
      const declared = postgresScope(app, manifest);
      if (!declared) continue;
      const { engine, ownerRole: role, database } = declared;
      for (const container of app.containers) {
        if (container.containerName === scope.engine) continue;
        const state = await read<{ status: 'Running' | 'Stopped'; network?: Record<string, { addresses: { family: string; address: string }[] }> }>(
          `/1.0/instances/${e(container.containerName)}/state`);
        credentialUses.push({ engine, database, role, appId: app.appId, container: container.containerName,
          state: state.status, clientAddresses: Object.values(state.network ?? {}).flatMap(n =>
            n.addresses.filter(a => a.family === 'inet' || a.family === 'inet6').map(a => a.address)) });
      }
    }
    const state = await containerState(scope.engine);
    if (state !== 'Running' && state !== 'Stopped') throw new Error('PostgreSQL engine identity unavailable');
    return { lifecycleExcluded: true, ingressBlocked, securityRevision: await securityRevision(current),
      engine: { name: scope.engine, state, ownerAppId: scope.mode === 'own' ? scope.appId : undefined },
      credentialUses };
  });
  io.persistStaging = persistStaging;
  return createAppUpdatePostgresProvider(scope, io);
}

export async function observeUpdateInventory(metadata: InstallMetadata): Promise<{
  observations: UpdateInventoryObservations; instances: Instance[];
}> {
  const observations: UpdateInventoryObservations = { containers: [], volumes: [], databases: [], pools: [] };
  const instances: Instance[] = [];
  const pools = new Set<string>();
  for (const container of metadata.containers) {
    const instance = await read<Instance>(`/1.0/instances/${e(container.containerName)}`);
    // App-owned network metadata proves provider ownership even on native roots.
    const nics = Object.values(instance.expanded_devices).filter(d => d.type === 'nic');
    if (nics.length !== 1 || !nics[0].network) code('foreign-or-missing-container', 'An app container has an unknown network identity.');
    const network = await read<{ config: Record<string, string>; used_by: string[] }>(`/1.0/networks/${e(nics[0].network)}`);
    if (network.config['user.youeye.kind'] !== 'app-network' || network.config['user.youeye.app_id'] !== metadata.appId) {
      code('foreign-or-missing-container', 'App container ownership cannot be proven.');
    }
    const root = Object.values(instance.expanded_devices).find(d => d.type === 'disk' && d.path === '/');
    if (!root?.pool || !instance.config['volatile.uuid']) code('old-runtime-unavailable', 'Installed runtime identity is incomplete.');
    pools.add(root.pool);
    const volumes = Object.values(instance.expanded_devices).filter(d => d.type === 'disk' && d.path !== '/'
      && !isManagedTrustMount(metadata.appId, d))
      .map(d => {
        if (!d.pool || !d.source || d.source.startsWith('/')) {
          code('unknown-mutable-volume', 'Host-path or unidentified app storage cannot be safely updated.');
        }
        const [name, ...components] = d.source.split('/');
        if (components.some(p => !p || p === '.' || p === '..')) code('unknown-mutable-volume', 'An app storage subpath is not contained.');
        return { pool: d.pool, name, sourcePath: components.length ? components.join('/') : undefined,
          containerPath: d.path, readOnly: d.readonly === 'true' };
      });
    const state = await containerState(container.containerName);
    if (state !== 'Running' && state !== 'Stopped') code('unknown-container-state', 'App container state is not supported for recovery.');
    observations.containers.push({ name: container.containerName, ownerAppId: metadata.appId, state,
      rootPool: root.pool, oldRuntimeAvailable: true, restoreSupported: true, volumes });
    instances.push(instance);
  }
  for (const v of metadata.storageVolumes ?? []) {
    if (observations.volumes.some(x => x.pool === v.pool && x.name === v.name)) continue;
    pools.add(v.pool);
    const volume = await read<Volume>(volumeURL(v.pool, v.name));
    const users = volume.used_by.map(url => {
      const match = /^\/1.0\/instances\/([^/?]+)(?:\?project=default)?$/.exec(url);
      return match ? decodeURIComponent(match[1]) : 'unknown-attachment';
    });
    observations.volumes.push({ pool: v.pool, name: v.name,
      ownerAppId: volume.config['user.youeye.kind'] === 'app' ? volume.config['user.youeye.app_id'] : undefined,
      sharedGroup: volume.config['user.youeye.kind'] === 'shared' ? volume.config['user.youeye.storage_group'] : undefined,
      contentType: volume.content_type, snapshotSupported: true, users });
  }
  for (const pool of pools) {
    const info = await read<{ driver: string }>(`/1.0/storage-pools/${e(pool)}`);
    const capacity = await read<{ space: { total: number; used: number } }>(`/1.0/storage-pools/${e(pool)}/resources`);
    if (!['zfs', 'btrfs', 'lvm', 'dir'].includes(info.driver)) code('volume-recovery-unavailable', 'Storage driver recovery is unsupported.');
    // Conservative full-copy budget includes each root's reported disk usage.
    let checkpointBytes = 0;
    for (const c of observations.containers.filter(c => c.rootPool === pool)) {
      const state = await read<{ disk: Record<string, { usage: number }> }>(`/1.0/instances/${e(c.name)}/state`);
      const usage = Object.values(state.disk ?? {}).reduce((sum, d) => sum + d.usage, 0);
      if (!Number.isSafeInteger(usage) || usage <= 0) code('unknown-recovery-capacity', 'Runtime checkpoint size could not be measured.');
      checkpointBytes += usage;
    }
    for (const v of observations.volumes.filter(v => v.pool === pool)) {
      const resources = await read<{ usage: { used: number } }>(`${volumeURL(pool, v.name)}/state`);
      if (!Number.isSafeInteger(resources.usage?.used)) code('unknown-recovery-capacity', 'Volume checkpoint size could not be measured.');
      checkpointBytes += resources.usage.used;
    }
    // Also reserve an independent restore working copy so interruption never
    // forces consumption/deletion of the only verified runtime checkpoint.
    observations.pools.push({ name: pool, availableBytes: capacity.space.total - capacity.space.used,
      checkpointBytes: checkpointBytes * 2,
      cleanupReserveBytes: Math.max(256 * 1024 * 1024, Math.ceil(checkpointBytes / 10)) });
  }
  return { observations, instances };
}

export class IncusAppUpdateProvider implements AppUpdateProvider {
  constructor(private readonly plan?: RecoveryPlan) {}
  private workspace(record: AppUpdateRecord) { return new AppUpdateWorkspace(undefined, record.id); }
  private load(record: AppUpdateRecord): RecoveryPlan {
    const data = this.workspace(record).get('plan');
    if (updateDigest(data) !== record.metadataBeforeSHA256) throw new Error('Recovery plan digest mismatch');
    const plan = JSON.parse(data.toString()) as RecoveryPlan;
    if (plan.metadata.appId !== record.appId || plan.manifest.metadata.id !== record.appId
      || JSON.stringify(plan.inventory.resources) !== JSON.stringify(record.resources)) {
      throw new Error('Recovery plan identity mismatch');
    }
    return plan;
  }
  private async postgres(record: AppUpdateRecord) {
    const plan = this.load(record);
    if (!plan.postgres) return undefined;
    return postgresProvider({ ...plan.postgres, operationId: record.id }, plan.metadata, true, async receipt => {
      this.workspace(record).put('postgres-staging', Buffer.from(JSON.stringify(receipt)));
    });
  }
  private fence(record: AppUpdateRecord): AppUpdatePostgresFence {
    return JSON.parse(this.workspace(record).get('postgres-fence').toString());
  }
  private optionalFence(record: AppUpdateRecord): AppUpdatePostgresFence | undefined {
    try { return this.fence(record); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private noProviderEffects(record: AppUpdateRecord): boolean {
    return !record.steps.some(step => step.phase !== 'preflight' && step.phase !== 'cleanup');
  }
  private async environments(plan: RecoveryPlan): Promise<Record<string, Record<string, string>>> {
    const environments: Record<string, Record<string, string>> = {};
    for (const spec of plan.manifest.containers) {
      const name = plan.metadata.containers.find(c => c.name === spec.name)!.containerName;
      if (spec.type === 'oci') {
        environments[spec.name] = Object.fromEntries(Object.entries(plan.instances.find(c => c.name === name)!.config)
          .filter(([key]) => key.startsWith('environment.')).map(([key, value]) => [key.slice(12), value]));
      } else {
        const bytes = await incusDownloadFile(name, `/etc/${name}.env`);
        if (bytes.length > 1024 * 1024) throw new Error('Installed environment is oversized');
        environments[spec.name] = Object.fromEntries(bytes.toString().split('\n').filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
          .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      }
    }
    return environments;
  }
  async configurationContext(canonical: Partial<VariableContext>): Promise<Partial<VariableContext>> {
    if (!this.plan) throw new Error('Preflight context is unavailable');
    return updateConfigurationContext(this.plan.manifest, await this.environments(this.plan), canonical);
  }
  async applyConfiguration(record: AppUpdateRecord, target: AppManifest, context: Partial<VariableContext>): Promise<void> {
    const plan = this.load(record);
    const environments = await this.environments(plan);
    for (const spec of target.containers) {
      const metadata = plan.metadata.containers.find(c => c.name === spec.name)!;
      if (metadata.containerName === plan.postgres?.engine) continue;
      const old = plan.manifest.containers.find(c => c.name === spec.name)!;
      const env = updateEnvironment({ ...plan.manifest.env_mapping, ...old.environment },
        { ...target.env_mapping, ...spec.environment }, environments[spec.name], context);
      const current = await read<Instance>(`/1.0/instances/${e(metadata.containerName)}`);
      if (await containerState(metadata.containerName) !== 'Stopped') throw new Error('Configuration requires a stopped runtime');
      if (spec.type === 'oci') {
        const config = { ...current.config };
        for (const key of Object.keys(config).filter(k => k.startsWith('environment.'))) delete config[key];
        for (const [key, value] of Object.entries(env)) config[`environment.${key}`] = value;
        if (spec.command) config['oci.entrypoint'] = resolveUpdateTemplate(spec.command, context);
        else if (old.command) delete config['oci.entrypoint'];
        await effect('PUT', `/1.0/instances/${e(metadata.containerName)}`, { ...current, config });
      } else {
        await incusUploadFile(metadata.containerName, `/etc/${metadata.containerName}.env`, Buffer.from(envToString(env)), { mode: '0600' });
      }
      // Resolve before writing, rejecting incomplete credential templates.
      for (const file of target.configFiles.filter(f => f.container === spec.name)) resolveUpdateTemplate(file.template, context);
      await writeAllConfigFiles(target.configFiles, spec.name, metadata.containerName, context,
        plan.metadata.storageVolumes?.filter(v => v.containerName === metadata.containerName) ?? [],
        spec.type !== 'oci');
    }
  }
  private async copyRuntime(record: AppUpdateRecord, source: string, reference: string, canonical: string) {
    if (await containerState(source) !== 'Stopped') throw new Error('Runtime checkpoint source must be stopped');
    if (await optionalInstance(reference)) throw new Error('Runtime recovery reference already exists');
    const original = await read<Instance>(`/1.0/instances/${e(source)}`);
    await effect('POST', '/1.0/instances', {
      ...buildRollbackCopyRequest(source, reference),
      config: { ...original.config, 'boot.autostart': 'false',
        'user.youeye.update_operation': record.id, 'user.youeye.update_source': canonical },
      devices: isolatedRecoveryDevices(original),
    });
    const copy = await read<Instance>(`/1.0/instances/${e(reference)}`);
    if (copy.config['user.youeye.update_operation'] !== record.id
      || copy.config['user.youeye.update_source'] !== canonical || await containerState(reference) !== 'Stopped'
      || Object.values(copy.expanded_devices).some(d => d.type === 'nic' || d.type === 'proxy')) {
      throw new Error('Runtime checkpoint did not verify its atomic ownership');
    }
  }
  /** Run offline hooks without booting ordinary services/queues from the old app. */
  async withMigrationRunner<T>(record: AppUpdateRecord, name: string, run: () => Promise<T>): Promise<T> {
    const original = this.load(record).instances.find(i => i.name === name);
    if (!original || this.load(record).postgres?.engine === name) throw new Error('Migration runner is outside the application writer set');
    if (await containerState(name) !== 'Stopped') await stopContainer(name);
    const current = await read<Instance>(`/1.0/instances/${e(name)}`);
    const oci = this.load(record).metadata.containers.find(c => c.containerName === name)?.type === 'oci';
    const config = { ...current.config };
    if (oci) {
      config['oci.entrypoint'] = "/bin/sh -c 'exec sleep 86400'";
      delete config['oci.command'];
    } else {
      config['raw.lxc'] = `${config['raw.lxc'] ?? ''}\nlxc.init.cmd = /bin/sh -c 'exec sleep 86400'\n`;
    }
    await effect('PUT', `/1.0/instances/${e(name)}`, { ...current, config });
    try {
      await startContainer(name);
      await waitForRunning(name);
      await waitForContainerExec(name);
      return await run();
    } finally {
      if (await containerState(name) === 'Running') await stopContainer(name);
      const latest = await read<Instance>(`/1.0/instances/${e(name)}`);
      const restored = { ...latest.config };
      for (const field of ['oci.entrypoint', 'oci.command', 'raw.lxc']) {
        if (Object.hasOwn(current.config, field)) restored[field] = current.config[field];
        else delete restored[field];
      }
      await effect('PUT', `/1.0/instances/${e(name)}`, { ...latest, config: restored });
    }
  }
  private async ensureCurrentSecurity(record: AppUpdateRecord) {
    const plan = this.load(record);
    const current = await readInstallMetadata(record.appId);
    if (!current || await securityRevision(current) !== plan.securityRevision) {
      throw new Error('Current app security changed; recovery must reconcile rather than restore old credentials');
    }
  }
  private async assertVolumeOwner(record: AppUpdateRecord, resource: UpdateResource) {
    const volume = await read<Volume>(volumeURL(resource.scope, resource.name));
    if (volume.content_type !== 'filesystem' || volume.config['user.youeye.kind'] !== 'app'
      || volume.config['user.youeye.app_id'] !== record.appId) throw new Error('Update volume ownership changed');
    const allowed = new Set([
      ...Object.keys(record.originalRunning),
      ...Object.keys(record.originalRunning).map((_, i) => runtimeReference(record, i)),
      ...Object.keys(record.originalRunning).map((_, i) => runtimeReference(record, i + Object.keys(record.originalRunning).length)),
    ]);
    if (volume.used_by.some(url => {
      const match = /^\/1.0\/instances\/([^/?]+)(?:\?project=default)?$/.exec(url);
      return !match || !allowed.has(decodeURIComponent(match[1]));
    })) throw new Error('Update volume acquired a foreign writer');
  }
  private async restoreVolumeDescription(record: AppUpdateRecord, resource: UpdateResource): Promise<void> {
    await this.assertVolumeOwner(record, resource);
    const original = this.load(record).volumeDescriptions.find(v => v.pool === resource.scope && v.name === resource.name);
    if (!original) throw new Error('Original volume metadata is unavailable');
    const url = volumeURL(resource.scope, resource.name);
    const current = await read<Volume>(url);
    if ((current.description ?? '') === original.description) return;
    if (current.description !== `youeye-app-update:${record.id}`) throw new Error('Volume metadata changed outside this operation');
    await effect('PUT', url, { description: original.description, config: current.config });
    if ((await read<Volume>(url)).description !== original.description) throw new Error('Original volume metadata did not converge');
  }
  async initialize(record: AppUpdateRecord): Promise<void> {
    if (!this.plan) throw new Error('Recovery plan unavailable');
    // Admission now owns capacity reservations. Recheck observations under
    // those reservations before quiescence/checkpoint or any app mutation.
    for (const pool of this.plan.capacity.pools) {
      const current = await read<{ space: { total: number; used: number } }>(`/1.0/storage-pools/${e(pool.name)}/resources`);
      if (current.space.total - current.space.used < pool.requiredBytes) {
        code('insufficient-recovery-capacity', 'App storage capacity changed before checkpoint admission.');
      }
    }
    const state = await statfs('/var/lib/youeye/state');
    if (state.bavail * state.bsize < this.plan.capacity.stateBytes) {
      code('insufficient-recovery-capacity', 'Protected recovery capacity changed before admission.');
    }
    this.workspace(record).put('plan', Buffer.from(JSON.stringify(this.plan)));
    this.load(record);
  }
  private async bootFence(record: AppUpdateRecord, fenced: boolean) {
    for (const original of this.load(record).instances) {
      const current = await optionalInstance(original.name);
      if (!current) {
        if (record.phase === 'recovering' && record.checkpoints.some(c => c.method === 'runtime-copy'
          && c.resource === updateResourceKey(record.resources.find(r => r.kind === 'container' && r.name === original.name)!))) continue;
        throw new Error('App runtime disappeared before checkpoint');
      }
      if (current.config['volatile.uuid'] !== original.config['volatile.uuid']
        && current.config['user.youeye.update_restored'] !== record.id) {
        throw new Error('App runtime identity changed outside the update');
      }
      const config = { ...current.config };
      if (fenced) config['boot.autostart'] = 'false';
      else if (Object.hasOwn(original.config, 'boot.autostart')) config['boot.autostart'] = original.config['boot.autostart'];
      else delete config['boot.autostart'];
      if (JSON.stringify(config) !== JSON.stringify(current.config)) {
        await effect('PUT', `/1.0/instances/${e(original.name)}`, { ...current, config });
      }
    }
  }
  private async ingress(record: AppUpdateRecord, blocked: boolean) {
    const plan = this.load(record);
    const config = await getConfig();
    const before = JSON.stringify(config);
    const id = `app-update-${record.appId}`;
    for (const server of Object.values(config.apps?.http?.servers ?? {})) {
      server.routes = (server.routes ?? []).filter(r => r['@id'] !== id);
      if (blocked) {
        // Preserve every existing route and current auth/grants; insert only this app's deny.
        const hosts = new Set<string>([`${plan.metadata.subdomain}.${plan.metadata.domain}`]);
        for (const route of server.routes) {
          if (route['@id']?.startsWith(`app-${record.appId}-`)) {
            for (const match of route.match ?? []) for (const host of match.host ?? []) hosts.add(host);
          }
        }
        server.routes.unshift({ '@id': id, match: [{ host: [...hosts] }],
          handle: [{ handler: 'static_response', status_code: 503, body: 'Application maintenance' }], terminal: true });
      }
    }
    if (JSON.stringify(config) !== before) await setConfig(config);
    const observed = await getConfig();
    if (Object.values(observed.apps?.http?.servers ?? {}).some(s =>
      (s.routes ?? []).some(r => r['@id'] === id)) !== blocked) throw new Error('App ingress fence did not converge');
  }
  async quiesce(record: AppUpdateRecord): Promise<void> {
    await this.bootFence(record, true);
    await this.ingress(record, true);
    for (const name of Object.keys(record.originalRunning)) {
      if (this.load(record).postgres?.engine === name) continue;
      if (await containerState(name) === 'Running') await stopContainer(name);
      if (await containerState(name) !== 'Stopped') throw new Error('App writers did not quiesce');
    }
    const pg = await this.postgres(record);
    if (pg) {
      const scope = this.load(record).postgres!;
      if (scope.mode === 'own' && await containerState(scope.engine) === 'Stopped') {
        await startContainer(scope.engine);
        await waitForRunning(scope.engine);
      }
      await pg.preflightFence(async receipt => {
        this.workspace(record).put('postgres-fence', Buffer.from(JSON.stringify(receipt)));
      });
    }
  }
  async applying(record: AppUpdateRecord): Promise<void> {
    const pg = await this.postgres(record);
    if (pg) await pg.unfence(this.fence(record), 'apply');
  }
  async executeSQL(record: AppUpdateRecord, sql: string): Promise<void> {
    const pg = await this.postgres(record);
    if (!pg) throw new Error('SQL migration has no dedicated recovery database');
    await pg.executeSQL(this.fence(record), sql);
  }
  async fenceRecovery(record: AppUpdateRecord): Promise<void> {
    if (this.noProviderEffects(record)) return;
    const plan = this.load(record);
    await this.bootFence(record, true);
    await this.ingress(record, true);
    for (const original of plan.instances) {
      if (original.name === plan.postgres?.engine) continue;
      const instance = await optionalInstance(original.name);
      // A absent/replaced runtime cannot be started by us; a foreign UUID is
      // never stopped based merely on a reused canonical name.
      if (!instance) continue;
      const restored = instance.config['user.youeye.update_restored'] === record.id;
      if (!restored && instance.config['volatile.uuid'] !== original.config['volatile.uuid']) {
        throw new Error('Recovery fence cannot prove runtime identity');
      }
      if (await containerState(original.name) === 'Running') await stopContainer(original.name);
      if (await containerState(original.name) !== 'Stopped') throw new Error('Recovery writer fence did not verify');
    }
    const pg = await this.postgres(record);
    const fence = this.optionalFence(record);
    if (pg && fence) {
      if (plan.postgres?.mode === 'own' && await containerState(plan.postgres.engine) === 'Stopped') {
        await startContainer(plan.postgres.engine);
        await waitForRunning(plan.postgres.engine);
      }
      await pg.refence(fence);
    }
  }
  async checkpoint(record: AppUpdateRecord, resource: UpdateResource): Promise<UpdateCheckpoint> {
    const plan = this.load(record);
    const point = { resource: updateResourceKey(resource), verifiedAt: new Date().toISOString() };
    if (resource.kind === 'metadata') {
      const reference = 'plan';
      const raw = this.workspace(record).get(reference);
      return { ...point, method: 'scoped-metadata', reference, sha256: updateDigest(raw) };
    }
    if (resource.kind === 'container') {
      const index = plan.instances.findIndex(c => c.name === resource.name);
      const reference = runtimeReference(record, index);
      // The database engine is stopped only while copying its exact old runtime.
      // Logical dumps remain the authority for its data.
      const databaseEngine = plan.postgres?.engine === resource.name;
      if (databaseEngine && await containerState(resource.name) === 'Running') await stopContainer(resource.name);
      await this.copyRuntime(record, resource.name, reference, resource.name);
      const original = plan.instances[index];
      if (databaseEngine) { await startContainer(resource.name); await waitForRunning(resource.name); }
      return { ...point, method: 'runtime-copy', reference,
        sha256: updateDigest(JSON.stringify([original.config['volatile.uuid'], resource.name, record.id])) };
    }
    if (resource.kind === 'volume') {
      await this.assertVolumeOwner(record, resource);
      const reference = pointName(record);
      const url = volumeURL(resource.scope, resource.name);
      const existing = await incusRequest<Volume>('GET', `${url}/snapshots/${e(reference)}`);
      if (existing.type !== 'error' || existing.error_code !== 404) {
        throw new Error('Update checkpoint absence could not be verified');
      }
      const original = plan.volumeDescriptions.find(v => v.pool === resource.scope && v.name === resource.name);
      const current = await read<Volume>(url);
      if (!original || (current.description ?? '') !== original.description) throw new Error('Volume metadata changed before checkpoint');
      // Incus snapshot POST inherits parent metadata and ignores description.
      // Persist the original in the encrypted plan before this intent, tag the
      // parent, then atomically create the snapshot with inherited ownership.
      await effect('PUT', url, { description: `youeye-app-update:${record.id}`, config: current.config });
      await effect('POST', `${url}/snapshots`, { name: reference });
      const snapshot = await read<Volume>(`${volumeURL(resource.scope, resource.name)}/snapshots/${e(reference)}`);
      if (snapshot.description !== `youeye-app-update:${record.id}`) throw new Error('Volume checkpoint ownership did not verify');
      await this.restoreVolumeDescription(record, resource);
      return { ...point, method: 'volume-snapshot', reference, sha256: updateDigest(JSON.stringify(snapshot)) };
    }
    if (resource.kind === 'database') {
      const pg = await this.postgres(record);
      if (!pg) throw new Error('Database recovery adapter is missing');
      const checkpoint = await pg.dump(this.fence(record));
      const { bytes, ...header } = checkpoint;
      const reference = 'postgres-dump';
      this.workspace(record).put(reference, bytes);
      this.workspace(record).put('postgres-header', Buffer.from(JSON.stringify(header)));
      return { ...point, method: 'logical-postgres', reference, sha256: checkpoint.sha256 };
    }
    throw new Error('Database checkpoint adapter is not available');
  }
  async validateCheckpoints(record: AppUpdateRecord): Promise<void> {
    this.load(record);
    for (const point of record.checkpoints) {
      const resource = record.resources.find(r => updateResourceKey(r) === point.resource)!;
      if (point.method === 'runtime-copy') {
        const copy = await read<Instance>(`/1.0/instances/${e(point.reference)}`);
        const original = this.load(record).instances.find(i => i.name === resource.name)!;
        if (copy.config['user.youeye.update_operation'] !== record.id
          || copy.config['user.youeye.update_source'] !== resource.name
          || copy.config['image.id'] !== original.config['image.id']
          || copy.config['volatile.base_image'] !== original.config['volatile.base_image']
          || await containerState(point.reference) !== 'Stopped') throw new Error('Runtime checkpoint identity mismatch');
      } else if (point.method === 'volume-snapshot') {
        await this.assertVolumeOwner(record, resource);
        const snapshot = await read<Volume>(`${volumeURL(resource.scope, resource.name)}/snapshots/${e(point.reference)}`);
        if (snapshot.description !== `youeye-app-update:${record.id}`
          || updateDigest(JSON.stringify(snapshot)) !== point.sha256) throw new Error('Volume checkpoint identity mismatch');
      } else if (point.method === 'scoped-metadata') {
        if (updateDigest(this.workspace(record).get(point.reference)) !== point.sha256) throw new Error('Metadata checkpoint mismatch');
      } else if (point.method === 'logical-postgres') {
        if (updateDigest(this.workspace(record).get(point.reference)) !== point.sha256) throw new Error('Database checkpoint digest mismatch');
      } else throw new Error('Database checkpoint validation unavailable');
    }
  }
  async restore(record: AppUpdateRecord): Promise<void> {
    const initialized = record.steps.find(s => s.id === 'initialize-recovery-plan');
    if (!initialized || (initialized.state === 'intent' && record.phase === 'recovering'
      && record.steps.length === 1)) {
      // No provider effect was allowed before initialization acknowledgement.
      if (!this.plan) return;
    }
    const plan = this.load(record);
    await this.ensureCurrentSecurity(record);
    await this.ingress(record, true);
    await this.bootFence(record, true);
    for (const name of Object.keys(record.originalRunning)) {
      if (await containerState(name) === 'Running') await stopContainer(name);
    }
    const mutated = record.steps.some(s => s.phase === 'applying' || s.phase === 'verifying');
    if (mutated) {
      await this.validateCheckpoints(record);
      for (const point of record.checkpoints.filter(c => c.method === 'runtime-copy')) {
        const resource = record.resources.find(r => updateResourceKey(r) === point.resource)!;
        const original = plan.instances.find(i => i.name === resource.name)!;
        const retained = await read<Instance>(`/1.0/instances/${e(point.reference)}`);
        // Reconcile earlier owned checkpoints that retained network identities.
        // This changes only offline attachment configuration, never their root.
        if (Object.values(retained.expanded_devices).some(d => d.type === 'nic' || d.type === 'proxy')) {
          await effect('PUT', `/1.0/instances/${e(point.reference)}`, { ...retained,
            devices: isolatedRecoveryDevices(retained) });
          const isolated = await read<Instance>(`/1.0/instances/${e(point.reference)}`);
          if (Object.values(isolated.expanded_devices).some(d => d.type === 'nic' || d.type === 'proxy')) {
            throw new Error('Runtime checkpoint network isolation did not verify');
          }
        }
        // A previous recovery may have started this root during health checks.
        // Recopy on every retry so root, volumes and SQL share the checkpoint
        // boundary; an ownership tag alone proves no immutability.
        // Retain immutable original copy across interrupted/failed restoration.
        const temporary = `ye-rollback-${record.id.replaceAll('-', '').slice(0, 12)}-${plan.instances.length + plan.instances.findIndex(i => i.name === resource.name)}`;
        const retainedTemporary = await optionalInstance(temporary);
        if (retainedTemporary) {
          if (retainedTemporary.config['user.youeye.update_operation'] !== record.id
            || retainedTemporary.config['user.youeye.update_source'] !== resource.name) {
            throw new Error('Recovery temporary runtime has foreign ownership');
          }
          if (await containerState(temporary) !== 'Stopped') throw new Error('Recovery temporary runtime is not stopped');
          await deleteInstance(temporary);
        }
        await this.copyRuntime(record, point.reference, temporary, resource.name);
        const replacement = await read<Instance>(`/1.0/instances/${e(temporary)}`);
        await effect('PUT', `/1.0/instances/${e(temporary)}`, { ...replacement,
          config: { ...replacement.config, 'user.youeye.update_restored': record.id, 'boot.autostart': 'false' } });
        await deleteInstance(resource.name);
        await effect('POST', `/1.0/instances/${e(temporary)}`, { name: resource.name });
        const canonical = await read<Instance>(`/1.0/instances/${e(resource.name)}`);
        await effect('PUT', `/1.0/instances/${e(resource.name)}`, { ...canonical,
          devices: original.devices, profiles: original.profiles });
      }
      for (const point of record.checkpoints.filter(c => c.method === 'volume-snapshot')) {
        const resource = record.resources.find(r => updateResourceKey(r) === point.resource)!;
        await this.assertVolumeOwner(record, resource);
        await effect('PUT', volumeURL(resource.scope, resource.name), { restore: point.reference });
        await this.restoreVolumeDescription(record, resource);
      }
      const pg = await this.postgres(record);
      if (pg) {
        if (plan.postgres!.mode === 'own') { await startContainer(plan.postgres!.engine); await waitForRunning(plan.postgres!.engine); }
        const header = JSON.parse(this.workspace(record).get('postgres-header').toString());
        const checkpoint: AppUpdatePostgresCheckpoint = { ...header, bytes: this.workspace(record).get('postgres-dump') };
        let retained: AppUpdatePostgresSecurity | undefined;
        try {
          const value = JSON.parse(this.workspace(record).get('postgres-security').toString());
          retained = { ...value, bytes: this.workspace(record).get('postgres-security-bytes') };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await pg.restore(this.fence(record), checkpoint, {
          security: retained,
          persistSecurity: async security => {
            const { bytes, ...header } = security;
            this.workspace(record).put('postgres-security-bytes', bytes);
            this.workspace(record).put('postgres-security', Buffer.from(JSON.stringify(header)));
          },
        });
      }
      // Current policy and credential metadata wins. Restore only update-owned fields.
      const current = await readInstallMetadata(record.appId);
      if (!current) throw new Error('App metadata disappeared during recovery');
      const restored = { ...current };
      const keys = ['installedVersion', 'catalogKey', 'itemKind', 'sourceId', 'sourceName', 'sourceRepoUrl',
        'manifestSource', 'manifestPath', 'manifestRepo', 'manifestBranch', 'manifestDigest',
        'nativeArtifacts', 'containers', 'entrances', 'appliedMigrations'] as const;
      for (const key of keys) {
        if (Object.hasOwn(plan.metadata, key)) Object.assign(restored, { [key]: plan.metadata[key] });
        else delete restored[key];
      }
      await saveInstallMetadata(restored);
      await restoreInstalledAppUpdateState(record.appId, plan.installed);
      await syncAppManifestObjectToUI(record.appId, plan.manifest as unknown as Record<string, unknown>);
    }
  }
  async verifyRestored(record: AppUpdateRecord): Promise<void> {
    // No checkpoint/provider effects exist if initialization itself was interrupted.
    if (this.noProviderEffects(record)) return;
    const plan = this.load(record);
    if (plan.postgres?.mode === 'own' && await containerState(plan.postgres.engine) === 'Stopped') {
      await startContainer(plan.postgres.engine);
      await waitForRunning(plan.postgres.engine);
    }
    const pg = await this.postgres(record);
    const fence = this.optionalFence(record);
    if (pg && fence) { await pg.unfence(fence, 'apply'); }
    const metadata = await readInstallMetadata(record.appId);
    if (metadata?.installedVersion !== plan.metadata.installedVersion) throw new Error('Restored version does not agree with checkpoint');
    for (const original of plan.instances) {
      const current = await read<Instance>(`/1.0/instances/${e(original.name)}`);
      if (current.config['volatile.base_image'] !== original.config['volatile.base_image']) throw new Error('Restored runtime differs from checkpoint');
      if (record.originalRunning[original.name]) {
        if (await containerState(original.name) !== 'Running') await startContainer(original.name);
        await waitForRunning(original.name);
        await waitForContainerExec(original.name);
        const spec = plan.manifest.containers.find(c => c.name === plan.metadata.containers.find(m => m.containerName === original.name)?.name)!;
        if (spec.healthCheck?.type === 'http'
          && !await waitForAppHealth(original.name, spec.port ?? 80, spec.healthCheck.path, spec.healthCheck.timeout)) {
          throw new Error('Restored app health did not verify');
        }
        if (spec.healthCheck?.type === 'postgres'
          && !await waitForPostgresHealth(original.name, spec.healthCheck.user, spec.healthCheck.timeout)) {
          throw new Error('Restored PostgreSQL health did not verify');
        }
      } else if (await containerState(original.name) !== 'Stopped') throw new Error('Original stopped state was not restored');
    }
  }
  async reopen(record: AppUpdateRecord): Promise<void> {
    if (this.noProviderEffects(record)) return;
    const plan = this.load(record);
    await this.ensureCurrentSecurity(record);
    // Recheck frozen runtime identity before starting any fenced workload.
    await this.bootFence(record, true);
    const pg = await this.postgres(record);
    const fence = this.optionalFence(record);
    if (pg && fence) {
      // Original grants are restored while ordinary app clients are stopped.
      for (const name of Object.keys(record.originalRunning).filter(n => n !== plan.postgres!.engine)) {
        if (await containerState(name) === 'Running') await stopContainer(name);
      }
      // A reboot can stop the fenced app-owned engine after durable commit.
      // Bring only that scoped engine up before logical grant reconciliation,
      // then restore its original desired state with the rest of the app.
      if (plan.postgres!.mode === 'own') {
        const engine = plan.postgres!.engine;
        if (await containerState(engine) === 'Stopped') {
          await startContainer(engine);
          await waitForRunning(engine);
        }
        if (!await waitForPostgresHealth(engine, plan.postgres!.adminRole, 60_000)) {
          throw new Error('Scoped PostgreSQL is not ready to finish application recovery');
        }
      }
      await pg.unfence(fence, 'original');
    }
    for (const [name, running] of Object.entries(record.originalRunning)) {
      if (!running && await containerState(name) === 'Running') await stopContainer(name);
      if (running && await containerState(name) === 'Stopped') { await startContainer(name); await waitForRunning(name); }
    }
    await this.bootFence(record, false);
    await this.ingress(record, false);
  }
  async cleanup(record: AppUpdateRecord): Promise<void> {
    if (this.noProviderEffects(record)) {
      this.workspace(record).remove();
      return;
    }
    try { this.load(record); } catch (error) {
      // Deletion is the final provider effect. Reconcile death after deletion
      // but before journal acknowledgement by proving every external point is
      // absent. Missing payload alone is never accepted as cleanup evidence.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        || !record.steps.some(s => s.id === 'reopen-compatible-app' && s.state === 'completed')
        || (!record.commit && !record.rollbackVerifiedAt)) throw error;
      for (let i = 0; i < Object.keys(record.originalRunning).length * 2; i++) {
        if (await optionalInstance(runtimeReference(record, i))) throw new Error('Cleanup plan missing with retained runtimes');
      }
      for (const resource of record.resources.filter(r => r.kind === 'volume' && r.mutable)) {
        const result = await incusRequest('GET', `${volumeURL(resource.scope, resource.name)}/snapshots/${e(pointName(record))}`);
        if (result.type !== 'error' || result.error_code !== 404) throw new Error('Cleanup plan missing with retained volumes');
      }
      for (const resource of record.resources.filter(r => r.kind === 'database')) {
        const result = await execCommand(resource.scope, ['sh', '-c',
          `test ! -e '/tmp/youeye-app-pg-${record.id}' && test ! -L '/tmp/youeye-app-pg-${record.id}'`], { timeout: 10_000 });
        if (result.exitCode !== 0) throw new Error('Cleanup plan missing with retained database staging');
      }
      this.workspace(record).remove();
      return;
    }
    const pg = await this.postgres(record);
    if (pg) await pg.cleanupStaging();
    // Cleanup enumeration derives names from operation ownership, never a broad prefix.
    const names = Object.keys(record.originalRunning);
    for (let index = 0; index < names.length * 2; index++) {
      const reference = runtimeReference(record, index);
      const copy = await incusRequest<Instance>('GET', `/1.0/instances/${e(reference)}`);
      if (copy.type === 'error' && copy.error_code === 404) continue;
      if (copy.type === 'error' || copy.metadata.config['user.youeye.update_operation'] !== record.id) {
        throw new Error('Cleanup runtime ownership cannot be verified');
      }
      await deleteInstance(reference);
    }
    for (const resource of record.resources.filter(r => r.kind === 'volume' && r.mutable)) {
      await this.assertVolumeOwner(record, resource);
      await this.restoreVolumeDescription(record, resource);
      const url = `${volumeURL(resource.scope, resource.name)}/snapshots/${e(pointName(record))}`;
      const snapshot = await incusRequest<Volume>('GET', url);
      if (snapshot.type === 'error' && snapshot.error_code === 404) continue;
      if (snapshot.type === 'error' || snapshot.metadata.description !== `youeye-app-update:${record.id}`) {
        throw new Error('Cleanup volume checkpoint ownership cannot be verified');
      }
      await effect('DELETE', url);
    }
    this.workspace(record).remove();
  }
}

export async function prepareIncusAppUpdate(metadata: InstallMetadata, target: AppManifest) {
  const old = await readFrozenUpdateManifest(metadata.appId);
  if (old.version !== metadata.installedVersion) code('frozen-version-mismatch', 'Installed manifest and recorded runtime version disagree.');
  const { observations, instances } = await observeUpdateInventory(metadata);
  let stateBytes = 32 * 1024 * 1024;
  const postgres = postgresScope(metadata, old);
  if (postgres?.mode === 'own') {
    const engine = metadata.containers.find(c => c.containerName === postgres.engine);
    const before = old.containers.find(c => c.name === engine?.name);
    const after = target.containers.find(c => c.name === engine?.name);
    if (!before || !after || before.image !== after.image || before.type !== after.type) {
      code('postgres-runtime-change-excluded', 'Update the PostgreSQL platform separately; app transactions retain the exact database runtime.');
    }
  }
  if (postgres) {
    const pg = await postgresProvider(postgres, metadata, false);
    const staging = await pg.stagingCapacity();
    stateBytes = staging.reservedBytes + 16 * 1024 * 1024;
    if (staging.availableBytes < staging.reservedBytes + 16 * 1024 * 1024) {
      code('insufficient-recovery-capacity', 'PostgreSQL staging lacks recovery and cleanup capacity.');
    }
    const state = await statfs('/var/lib/youeye/state');
    if (state.bavail * state.bsize < staging.reservedBytes + 16 * 1024 * 1024) {
      code('insufficient-recovery-capacity', 'Protected update state lacks encrypted recovery capacity.');
    }
    const engine = await read<Instance>(`/1.0/instances/${e(postgres.engine)}`);
    const pool = Object.values(engine.expanded_devices).find(d => d.type === 'disk' && d.path === '/')?.pool;
    const capacity = observations.pools.find(p => p.name === pool);
    if (capacity) capacity.checkpointBytes += staging.reservedBytes;
    observations.databases.push(await pg.observations());
  }
  const inventory = planAppUpdateInventory(metadata, old, target, observations);
  const volumeDescriptions = await Promise.all(inventory.resources.filter(r => r.kind === 'volume' && r.mutable).map(async r => {
    const volume = await read<Volume>(volumeURL(r.scope, r.name));
    return { pool: r.scope, name: r.name, description: volume.description ?? '' };
  }));
  const installed = await getInstalledApp(metadata.appId);
  if (!installed) throw new Error('Installed app disappeared during preflight');
  const plan: RecoveryPlan = { metadata, installed: stateOf(installed), manifest: old, inventory, instances,
    postgres, securityRevision: await securityRevision(metadata),
    capacity: { pools: observations.pools.map(p => ({ name: p.name, requiredBytes: p.checkpointBytes + p.cleanupReserveBytes })), stateBytes },
    volumeDescriptions };
  return { inventory, old, provider: new IncusAppUpdateProvider(plan),
    sourceArtifacts: [
      ...(metadata.nativeArtifacts?.map(a => a.sha256) ?? []),
      ...instances.flatMap(c => /@sha256:([a-f0-9]{64})/.exec(c.config['image.id'] ?? '')?.[1] ?? []),
    ],
    metadataBeforeSHA256: updateDigest(JSON.stringify(plan)) };
}
