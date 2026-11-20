import { rm, readdir, lstat, readFile, statfs } from 'node:fs/promises';
import { incusRequest, execCommand, incusDownloadFile, incusUploadFile } from '@/lib/incus/server';
import {
  containerState, stopContainer, forceStopContainer, stopTimeoutSec, ContainerStopTimeoutError,
  startContainer, waitForRunning, waitForContainerExec,
  deleteInstance, waitForOperation,
  buildRollbackCopyRequest,
} from '@/lib/incus/snapshot';
import { containerTargets, orderContainers, type ContainerTarget } from '@/lib/apps/container-order';
import { ownDatabaseEngine, readinessCheck } from '@/lib/apps/container-readiness';
import { getConfig, setConfig } from '@/lib/caddy/client';
import { routeServers } from '@/lib/caddy/servers';
import { withCaddyMutation } from '@/lib/caddy/serial';
import { readInstallMetadata, saveInstallMetadata, listInstalledApps } from './metadata';
import { appServiceCredentials } from '../apps/service-credential-store';
import { getAdmissionSnapshot } from '../admission/store';
import { identityRows, identitySql } from '../identity/store';
import { getInstalledApp, restoreInstalledAppUpdateState, type InstalledAppUpdateState } from './installed-apps';
import { syncAppManifestObjectToUI } from './ui-manifest-sync';
import { readFrozenUpdateManifest } from './frozen-manifest';
import { describeErrorChainForLog } from './install-tracker';
import { getBridgesForApp } from '../bridges/store';
import { integrationAclName } from '../incus/app-network';
export { readFrozenUpdateManifest } from './frozen-manifest';
import type { AppManifest, InstallMetadata, VariableContext } from './types';
import { writeAllConfigFiles } from './config-writer';
import { envToString } from './platform-env';
import { CONTAINER_DOMAIN } from './constants';
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
  /** Absent in plans written before 0.6.9 (they held an overall revision made by an older function). */
  securityParts?: SecurityParts;
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
/**
 * The app's own security state that an update must never roll back across: who owns it and its data, how users
 * reach it, its credentials and its secrets. Only this app's state: no timestamps, no box-wide user list. Fields the
 * update itself writes (versions, manifest references, containers, release floors, updatedAt) are not here.
 */
const SECURITY_FIELDS = ['appId', 'installationId', 'admissionOwnerId', 'integration', 'enableSSO', 'hasSSO',
  'ssoClientId', 'ssoSlug', 'forwardAuthEnabled', 'forwardAuthSlug', 'protectWithAccountLogin', 'perUserData',
  'subdomain', 'domain', 'selectedIntegrations', 'usePerAppBridge', 'databaseMode', 'databaseName', 'databaseUser',
  'databasePasswordFile', 'sharedFolders', 'storageVolumes', 'credentials', 'aiConnection',
  'serviceCredentialState'] as const satisfies ReadonlyArray<keyof InstallMetadata>;
const SECRET_FILE_LIMIT = { files: 256, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, depth: 4 };
type SecurityParts = { metadata: string; files: string; credential: string; admission: string; resources: string };
function stable(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}
/** Every regular file under the app directory (secrets/ included), bounded; links and devices are refused. */
async function securityFiles(dir: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = [];
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    for (const name of (await readdir(relative ? `${dir}/${relative}` : dir)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (!relative && (name === 'install.json' || name.startsWith('.install-'))) continue;
      const stat = await lstat(`${dir}/${path}`);
      if (stat.isDirectory() && depth < SECRET_FILE_LIMIT.depth) { await walk(path, depth + 1); continue; }
      total += stat.size;
      if (!stat.isFile() || stat.size > SECRET_FILE_LIMIT.fileBytes || files.length >= SECRET_FILE_LIMIT.files
        || total > SECRET_FILE_LIMIT.totalBytes) {
        code('unknown-security-state', `App security file ${path} is not a bounded regular file.`);
      }
      files.push([path, updateDigest(await readFile(`${dir}/${path}`))]);
    }
  };
  await walk('', 0);
  return files;
}
async function securityParts(metadata: InstallMetadata): Promise<SecurityParts> {
  const fields = Object.fromEntries(SECURITY_FIELDS.filter(key => Object.hasOwn(metadata, key))
    .map(key => [key, metadata[key]]));
  const files = await securityFiles(`/var/lib/youeye/app-${metadata.appId}`);
  const credential = await appServiceCredentials.projection(metadata.appId);
  const admission = await getAdmissionSnapshot(metadata.appId);
  if (!credential || !admission) code('unknown-security-state', 'App credential and ownership authority must be available.');
  const { installationId, generation, revision, status, verifierHash } = credential;
  const { appId, ownerId, mode, userIds, groupIds, publicAccess, state } = admission.policy;
  // The policy revision moves when anything that changes this app's admission changes (database triggers), so the
  // box-wide principal list is not needed. Per-user private resources are left out for the same reason.
  const resources = await identityRows(`SELECT r.resource_id, r.declaration, r.owner_id, r.state
    FROM admission_resources r JOIN admission_policies p USING (installation_id)
    WHERE p.app_id = ${identitySql(metadata.appId)} AND r.private_user_id IS NULL ORDER BY r.resource_id`);
  return {
    metadata: updateDigest(stable(fields)),
    files: updateDigest(stable(files)),
    credential: updateDigest(stable({ installationId, generation, revision, status, verifierHash })),
    admission: updateDigest(stable({ appId, installationId: admission.policy.installationId, ownerId, mode, userIds,
      groupIds, publicAccess, state, revision: admission.policy.revision })),
    resources: updateDigest(stable(resources)),
  };
}
/** The logical checkpoint is for an app's database in the shared platform PostgreSQL only. */
function postgresScope(metadata: InstallMetadata, manifest: AppManifest): AppUpdatePostgresScope | undefined {
  if (manifest.database?.mode !== 'shared') return undefined;
  const resolve = (value: string | undefined) => {
    if (!value) code('unknown-database-identity', 'A database resource identity is missing.');
    return value.replaceAll('${app.id}', metadata.appId).replaceAll('${app.name}', metadata.appId);
  };
  return {
    appId: metadata.appId, engine: 'youeye-postgres',
    database: resolve(manifest.database.name), ownerRole: resolve(manifest.database.user),
    adminRole: 'youeye', adminRoles: ['youeye', 'postgres'],
    maxDumpBytes: 64 * 1024 * 1024,
  };
}
/** The container that runs an app's own database (`database.mode: own`), by its installed name. */
async function postgresProvider(
  scope: AppUpdatePostgresScope, metadata: InstallMetadata, ingressBlocked: boolean,
  persistStaging?: (receipt: AppUpdatePostgresStaging) => Promise<void>,
) {
  const io = incusAppUpdatePostgresIO(async () => {
    const current = await readInstallMetadata(metadata.appId);
    if (!current) throw new Error('App security metadata is unavailable');
    const credentialUses = [];
    for (const app of await listInstalledApps()) {
      // Include the entire recorded credential closure of this database's role, even stopped workloads. Another
      // app's install in progress has no registration or containers yet, and can't hold this role (a role collision
      // is refused at install), so it is skipped instead of failing the observation (and stranding this update).
      if (app.databaseMode === 'none') continue;
      if (app.appId !== metadata.appId && app.lifecycleState === 'installing') continue;
      const manifest = await readFrozenUpdateManifest(app.appId, app.installedVersion);
      const declared = postgresScope(app, manifest);
      if (!declared) continue;
      const { engine, ownerRole: role, database } = declared;
      // Only uses of this database's owner role matter to the writer closure and the session check.
      if (app.appId !== metadata.appId && role !== scope.ownerRole) continue;
      for (const container of app.containers) {
        if (container.containerName === scope.engine) continue;
        const state = await read<{ status: 'Running' | 'Stopped'; network?: Record<string, { addresses: { family: string; address: string }[] }> }>(
          `/1.0/instances/${e(container.containerName)}/state`);
        credentialUses.push({ engine, database, role, appId: app.appId, container: container.containerName,
          state: state.status, clientAddresses: [...Object.values(state.network ?? {}).flatMap(n =>
            n.addresses.filter(a => a.family === 'inet' || a.family === 'inet6').map(a => a.address)),
          // Apps on their own network reach the shared Postgres through the doorway proxy device, which connects
          // from the host's address on the platform bridge: their sessions arrive from there. The session's role
          // (one per app, with its own password) is what identifies the app on that path.
          await platformBridgeHostAddress()] });
      }
    }
    const state = await containerState(scope.engine);
    if (state !== 'Running' && state !== 'Stopped') throw new Error('PostgreSQL engine identity unavailable');
    return { lifecycleExcluded: true, ingressBlocked, engine: { name: scope.engine, state }, credentialUses };
  });
  io.persistStaging = persistStaging;
  return createAppUpdatePostgresProvider(scope, io);
}

const GIB = 1024 * 1024 * 1024;

/** The host's address on the platform bridge (incusbr0): the source of every doorway connection to platform services. */
async function platformBridgeHostAddress(): Promise<string> {
  const bridge = await read<{ config: Record<string, string> }>('/1.0/networks/incusbr0');
  const address = bridge.config['ipv4.address']?.split('/')[0];
  if (!address) throw new Error('Platform bridge address unavailable');
  return address;
}
const COPY_ON_WRITE_DRIVERS = new Set(['zfs', 'btrfs']);

/** Apps this app has an active network connection with (a NIC on either side, per direction). */
async function activeConnectionPeers(appId: string): Promise<Set<string>> {
  const peers = new Set<string>();
  for (const bridge of await getBridgesForApp(appId)) {
    if (!bridge.active || bridge.accessMode === 'proxy' || bridge.accessMode === 'caddy') continue;
    if (bridge.from === appId) peers.add(bridge.to);
    else if (bridge.direction === 'both-ways') peers.add(bridge.from);
  }
  return peers;
}

/**
 * The migration runner's idle init. A bare `sleep` as PID 1 ignores stop signals, so a clean stop would always time
 * out. This one ends on the signals a clean stop may send (HUP, INT, QUIT, TERM, WINCH, PWR, RTMIN+3), given by number
 * so every shell accepts them, and with no quotes so it survives both entrypoint parsers.
 */
const IDLE_INIT = 'trap : 1 2 3 15 28 30 37; sleep 86400 & wait';

export async function observeUpdateInventory(metadata: InstallMetadata): Promise<{
  observations: UpdateInventoryObservations; instances: Instance[];
}> {
  const observations: UpdateInventoryObservations = { containers: [], volumes: [], databases: [], pools: [] };
  const instances: Instance[] = [];
  const pools = new Set<string>();
  const connectedApps = await activeConnectionPeers(metadata.appId);
  const seenConnections = new Set<string>();
  for (const container of metadata.containers) {
    const instance = await read<Instance>(`/1.0/instances/${e(container.containerName)}`);
    // App-owned network metadata proves provider ownership even on native roots: exactly one NIC on the app's own
    // network. Further NICs are connections (net-<app>, plugged by grantBridgeAccess): each needs an active
    // connection to that app, its network, and its scoped ACL.
    let own = 0;
    for (const [device, nic] of Object.entries(instance.expanded_devices).filter(([, d]) => d.type === 'nic')) {
      if (!nic.network) code('foreign-or-missing-container', `App container NIC ${device} has no managed network.`);
      const network = await read<{ config: Record<string, string> }>(`/1.0/networks/${e(nic.network)}`);
      const networkApp = network.config['user.youeye.kind'] === 'app-network' ? network.config['user.youeye.app_id'] : undefined;
      if (networkApp === metadata.appId) { own++; continue; }
      const peer = /^net-([a-z0-9][a-z0-9-]*)$/.exec(device)?.[1];
      if (!peer || networkApp !== peer || !connectedApps.has(peer)
        || nic['security.acls'] !== integrationAclName(container.containerName, peer)) {
        code('foreign-or-missing-container', `App container NIC ${device} is not an active connection of this app.`);
      }
    }
    if (own !== 1) code('foreign-or-missing-container', 'App container ownership cannot be proven: it needs exactly one NIC on its own app network.');
    for (const [device] of Object.entries(instance.expanded_devices).filter(([name, d]) => d.type === 'nic' && name.startsWith('net-'))) {
      seenConnections.add(device.slice(4));
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
  // The reverse check: an active connection whose NIC is already gone would pass a rebuild and then fail
  // verify-connections every time. Refuse it before any effect, naming the connection.
  for (const peer of connectedApps) {
    if (!seenConnections.has(peer)) {
      code('connection-interface-missing', `The connection to ${peer} has no network interface; re-activate it before updating.`);
    }
  }
  for (const v of metadata.storageVolumes ?? []) {
    if (observations.volumes.some(x => x.pool === v.pool && x.name === v.name)) continue;
    const volume = await read<Volume>(volumeURL(v.pool, v.name));
    // Shared folders are never checkpointed: their pool needs no recovery space.
    if (volume.config['user.youeye.kind'] !== 'shared') pools.add(v.pool);
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
    // The app's own data: each root's reported disk usage and its own volumes. Shared folders are never checkpointed
    // (they are not rolled back), so they are not counted.
    let checkpointBytes = 0;
    // Incus reports every pool-backed disk device of an instance in its state, custom volumes included: count only
    // the root device here (volumes are counted once, below, without shared folders).
    let rootBytes = 0;
    for (const c of observations.containers.filter(c => c.rootPool === pool)) {
      const instance = instances[observations.containers.indexOf(c)];
      const rootDevice = Object.entries(instance.expanded_devices).find(([, d]) => d.type === 'disk' && d.path === '/')?.[0];
      const state = await read<{ disk: Record<string, { usage: number }> }>(`/1.0/instances/${e(c.name)}/state`);
      const usage = rootDevice ? state.disk?.[rootDevice]?.usage : undefined;
      if (!Number.isSafeInteger(usage) || usage! <= 0) code('unknown-recovery-capacity', 'Runtime checkpoint size could not be measured.');
      rootBytes += usage!;
    }
    let volumeBytes = 0;
    for (const v of observations.volumes.filter(v => v.pool === pool && !v.sharedGroup)) {
      const resources = await read<{ usage: { used: number } }>(`${volumeURL(pool, v.name)}/state`);
      if (!Number.isSafeInteger(resources.usage?.used)) code('unknown-recovery-capacity', 'Volume checkpoint size could not be measured.');
      volumeBytes += resources.usage.used;
    }
    checkpointBytes = rootBytes + volumeBytes;
    const availableBytes = capacity.space.total - capacity.space.used;
    if (COPY_ON_WRITE_DRIVERS.has(info.driver)) {
      // Snapshots and instance copies share blocks: a rebuild rewrites the whole root (count it in full), data volumes
      // churn (10 %), plus a fixed 1 GiB reserve. Not a second full copy, which made large apps impossible to update.
      observations.pools.push({ name: pool, availableBytes,
        checkpointBytes: rootBytes + Math.ceil(volumeBytes / 10), cleanupReserveBytes: GIB });
    } else {
      // Full copies: also reserve an independent restore working copy so interruption never forces
      // consumption/deletion of the only verified runtime checkpoint.
      observations.pools.push({ name: pool, availableBytes,
        checkpointBytes: checkpointBytes * 2,
        cleanupReserveBytes: Math.max(256 * 1024 * 1024, Math.ceil(checkpointBytes / 10)) });
    }
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
    const ownEngine = ownDatabaseEngine(plan.metadata, plan.manifest);
    for (const spec of target.containers) {
      const metadata = plan.metadata.containers.find(c => c.name === spec.name)!;
      // An app's own database keeps its exact runtime: image, environment and configuration.
      if (metadata.containerName === ownEngine) continue;
      const old = plan.manifest.containers.find(c => c.name === spec.name)!;
      // The app's env belongs to its own container; sidecars carry only their own env.
      const env = updateEnvironment({ ...(old.primary ? plan.manifest.env_mapping : {}), ...old.environment },
        { ...(spec.primary ? target.env_mapping : {}), ...spec.environment }, environments[spec.name], context);
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
    const plan = this.load(record);
    const original = plan.instances.find(i => i.name === name);
    if (!original || ownDatabaseEngine(plan.metadata, plan.manifest) === name) throw new Error('Migration runner is outside the application writer set');
    if (await containerState(name) !== 'Stopped') await stopContainer(name, { timeoutSec: this.stopTimeout(plan, name) });
    const current = await read<Instance>(`/1.0/instances/${e(name)}`);
    const oci = plan.metadata.containers.find(c => c.containerName === name)?.type === 'oci';
    const config = { ...current.config };
    if (oci) {
      config['oci.entrypoint'] = `/bin/sh -c '${IDLE_INIT}'`;
      delete config['oci.command'];
    } else {
      config['raw.lxc'] = `${config['raw.lxc'] ?? ''}\nlxc.init.cmd = /bin/sh -c '${IDLE_INIT}'\n`;
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
  /**
   * Which parts of the app's security state changed since preflight (empty when none). A rollback never restores
   * security state: it restores data and keeps the current policy and credentials, so a change is logged, not fatal.
   * Plans written before 0.6.8 hold only an overall revision made by an older function; they report no parts.
   */
  private async securityChanges(record: AppUpdateRecord): Promise<string[]> {
    const plan = this.load(record);
    if (!plan.securityParts) return [];
    try {
      const current = await readInstallMetadata(record.appId);
      if (!current) return ['install record'];
      const now = await securityParts(current);
      return (Object.keys(now) as Array<keyof SecurityParts>).filter(key => now[key] !== plan.securityParts![key]);
    } catch (error) {
      // Advisory only: an unreadable identity database or secret must not block recovery.
      console.warn(`[app-update] ${record.appId} ${record.id}: security state unreadable during recovery: ${describeErrorChainForLog(error)}`);
      return ['unknown'];
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
    // Free space may have changed since preflight (another app's update, downloads): check it again before
    // quiescence/checkpoint or any app mutation.
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
    // Idempotent read-modify-write: serialized with the CP's other Caddy writers, and retried when a writer outside
    // the queue moved the revision (HTTP 412). A lost write here would leave a committed app behind the 503.
    for (let attempt = 1; ; attempt++) {
      try {
        await withCaddyMutation(() => this.ingressOnce(record, blocked));
        return;
      } catch (error) {
        if (attempt >= 5 || !(error instanceof Error && error.message.startsWith('Caddy API error: 412'))) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  private async ingressOnce(record: AppUpdateRecord, blocked: boolean) {
    const plan = this.load(record);
    const config = await getConfig();
    const before = JSON.stringify(config);
    const id = `app-update-${record.appId}`;
    for (const server of routeServers(config)) {
      server.routes = (server.routes ?? []).filter(r => r['@id'] !== id);
      if (blocked) {
        // Preserve every existing route and current auth/grants; insert only this app's deny.
        // The app's routes are the ones that proxy to a container its install record names.
        const hosts = new Set<string>([`${plan.metadata.subdomain}.${plan.metadata.domain}`]);
        const upstreams = new Set(plan.metadata.containers.flatMap(c => [c.containerName, `${c.containerName}.${CONTAINER_DOMAIN}`]));
        for (const route of server.routes) {
          const ownRoute = (route.handle ?? []).some((handler: { handler?: string; upstreams?: Array<{ dial?: string }> }) =>
            handler.handler === 'reverse_proxy'
            && (handler.upstreams ?? []).some(upstream => upstreams.has(String(upstream.dial ?? '').replace(/:\d+$/, ''))));
          if (ownRoute) {
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
  private targets(plan: RecoveryPlan, action: 'start' | 'stop'): ContainerTarget[] {
    return orderContainers(containerTargets(plan.metadata.containers), action);
  }
  private stopTimeout(plan: RecoveryPlan, name: string): number {
    return stopTimeoutSec(containerTargets(plan.metadata.containers).find(c => c.name === name)?.role);
  }
  /**
   * Every restore point the plan needs for container `name` exists: its runtime copy and the snapshot of each mutable
   * volume it mounts. Only then may a recovery kill it: what a kill could damage is overwritten by the restore, and
   * a restore point is never taken from a killed container.
   */
  private restorePointsTaken(record: AppUpdateRecord, plan: RecoveryPlan, name: string): boolean {
    const mounted = new Set((plan.metadata.storageVolumes ?? []).filter(v => v.containerName === name)
      .map(v => `${v.pool}\u0000${v.name}`));
    const needed = record.resources.filter(r => r.mutable && (
      (r.kind === 'container' && r.name === name)
      || (r.kind === 'volume' && mounted.has(`${r.scope}\u0000${r.name}`))));
    return needed.every(r => record.checkpoints.some(c => c.resource === updateResourceKey(r)
      && c.method === (r.kind === 'container' ? 'runtime-copy' : 'volume-snapshot')));
  }
  /** The update reached its apply phase: only then does `restore()` put the restore points back. */
  private mutated(record: AppUpdateRecord): boolean {
    return record.steps.some(s => s.phase === 'applying' || s.phase === 'verifying');
  }
  /**
   * A stop during recovery: clean, one more clean try, then forced. Forced only when a kill can cost nothing: the
   * restore points exist (a restore point is never taken from a killed container) and `restore()` will put them
   * back, which it does only for an update that reached its apply phase. Before that nothing is restored, so what a
   * kill damaged would stay damaged: the stop stays clean and recovery waits (retried).
   */
  private async stopForRecovery(record: AppUpdateRecord, plan: RecoveryPlan, name: string): Promise<void> {
    const timeoutSec = this.stopTimeout(plan, name);
    for (let attempt = 1; ; attempt++) {
      try {
        await stopContainer(name, { timeoutSec });
        return;
      } catch (error) {
        if (!(error instanceof ContainerStopTimeoutError)) throw error;
        if (attempt < 2) continue;
        if (!this.mutated(record) || !this.restorePointsTaken(record, plan, name)) throw error;
        console.warn(`[app-update] ${record.appId} ${record.id}: ${name} did not stop cleanly during recovery; forcing it (its restore point exists and is restored next)`);
        await forceStopContainer(name);
        return;
      }
    }
  }
  /** Start one container. A database or cache must accept work before the next container starts. */
  async startRuntime(record: AppUpdateRecord, name: string, manifest?: AppManifest): Promise<void> {
    const plan = this.load(record);
    if (await containerState(name) !== 'Running') await startContainer(name);
    await waitForRunning(name);
    await waitForContainerExec(name);
    const role = containerTargets(plan.metadata.containers).find(c => c.name === name)?.role;
    if (role === 'database' || role === 'cache') await this.waitReady(plan, name, manifest ?? plan.manifest);
  }
  /** The app's containers in start order: databases and caches first, the app last. */
  startOrder(record: AppUpdateRecord): string[] {
    return this.targets(this.load(record), 'start').map(c => c.name);
  }
  /** Readiness of one running container (`readinessCheck`): `pg_isready` for a database, else its HTTP health check. */
  private async waitReady(plan: RecoveryPlan, name: string, manifest: AppManifest): Promise<void> {
    const check = readinessCheck(plan.metadata, manifest, name);
    if (check?.type === 'postgres') {
      if (!await waitForPostgresHealth(name, check.user, check.timeoutMs)) throw new Error(`${name} did not accept database connections`);
    } else if (check?.type === 'http') {
      if (!await waitForAppHealth(name, check.port, check.path, check.timeoutMs)) throw new Error(`${name} did not pass its health check`);
    }
  }
  async quiesce(record: AppUpdateRecord): Promise<void> {
    const plan = this.load(record);
    await this.bootFence(record, true);
    await this.ingress(record, true);
    // Clean stops in stop order: the app first, its database last, so every volume is at rest for its snapshot.
    for (const { name } of this.targets(plan, 'stop')) {
      try {
        await stopContainer(name, { timeoutSec: this.stopTimeout(plan, name) });
      } catch (error) {
        if (!(error instanceof ContainerStopTimeoutError)) throw error;
        // No clean stop, no restore point, no update. Recovery starts what was stopped and reopens the app.
        code('writer-stop-timeout', `Update not started: ${name} did not stop in time. Nothing was changed.`);
      }
      if (await containerState(name) !== 'Stopped') throw new Error('App writers did not quiesce');
    }
    const pg = await this.postgres(record);
    if (pg) {
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
    const plan = this.load(record);
    if (plan.manifest.database?.mode === 'own') {
      code('sql-migration-own-database-unsupported', 'SQL migrations run in the shared platform database only.');
    }
    const pg = await this.postgres(record);
    if (!pg) throw new Error('SQL migration has no dedicated recovery database');
    await pg.executeSQL(this.fence(record), sql);
  }
  async fenceRecovery(record: AppUpdateRecord): Promise<void> {
    if (this.noProviderEffects(record)) return;
    const plan = this.load(record);
    await this.bootFence(record, true);
    await this.ingress(record, true);
    for (const { name } of this.targets(plan, 'stop')) {
      const original = plan.instances.find(i => i.name === name)!;
      const instance = await optionalInstance(name);
      // A absent/replaced runtime cannot be started by us; a foreign UUID is
      // never stopped based merely on a reused canonical name.
      if (!instance) continue;
      const restored = instance.config['user.youeye.update_restored'] === record.id;
      if (!restored && instance.config['volatile.uuid'] !== original.config['volatile.uuid']) {
        throw new Error('Recovery fence cannot prove runtime identity');
      }
      await this.stopForRecovery(record, plan, name);
      if (await containerState(name) !== 'Stopped') throw new Error('Recovery writer fence did not verify');
    }
    const pg = await this.postgres(record);
    const fence = this.optionalFence(record);
    if (pg && fence) await pg.refence(fence);
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
      // Every container is stopped (quiesce), an app's own database included: its copy and its volumes'
      // snapshots are one restore point.
      await this.copyRuntime(record, resource.name, reference, resource.name);
      const original = plan.instances[index];
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
    const securityChanged = await this.securityChanges(record);
    if (securityChanged.length) {
      console.warn(`[app-update] ${record.appId} ${record.id}: ${securityChanged.join(', ')} changed during the update; `
        + 'restoring data and keeping the current policy and credentials');
    }
    await this.ingress(record, true);
    await this.bootFence(record, true);
    const mutated = this.mutated(record);
    // Nothing was changed before the apply phase: what still runs keeps running, and verifyRestored starts the rest.
    if (mutated) {
      for (const { name } of this.targets(plan, 'stop')) await this.stopForRecovery(record, plan, name);
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
        // A copy gets new MAC addresses, and with them new addresses on the app network. Give the restored
        // container the original ones, so its routes, doorways and connections keep working. A separate write:
        // putting a NIC back (it was masked as `none`) makes Incus clear that NIC's volatile keys, including a MAC
        // set in the same request.
        // Not a reason to leave the app in recovery: its data is restored, and DHCP usually gives the address
        // back. So neither a rejected write nor a MAC that did not stick fails the rollback; both are logged.
        const macs = originalHardwareAddresses(original);
        let kept = false;
        try {
          const reattached = await read<Instance>(`/1.0/instances/${e(resource.name)}`);
          await effect('PUT', `/1.0/instances/${e(resource.name)}`, { ...reattached,
            config: { ...reattached.config, ...macs } });
          const written = await read<Instance>(`/1.0/instances/${e(resource.name)}`);
          kept = Object.entries(macs).every(([key, value]) => written.config[key] === value);
        } catch (error) {
          console.warn(`[app-update] ${record.appId} ${record.id}: the MAC addresses of restored ${resource.name} could not be written:`, error);
        }
        if (!kept) {
          console.warn(`[app-update] ${record.appId} ${record.id}: restored ${resource.name} did not keep its MAC `
            + 'addresses; its address on the app network may change');
        }
      }
      for (const point of record.checkpoints.filter(c => c.method === 'volume-snapshot')) {
        const resource = record.resources.find(r => updateResourceKey(r) === point.resource)!;
        await this.assertVolumeOwner(record, resource);
        await effect('PUT', volumeURL(resource.scope, resource.name), { restore: point.reference });
        await this.restoreVolumeDescription(record, resource);
      }
      const pg = await this.postgres(record);
      if (pg) {
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
        'nativeArtifacts', 'containers'] as const;
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
    const pg = await this.postgres(record);
    const fence = this.optionalFence(record);
    if (pg && fence) { await pg.unfence(fence, 'apply'); }
    const metadata = await readInstallMetadata(record.appId);
    if (metadata?.installedVersion !== plan.metadata.installedVersion) throw new Error('Restored version does not agree with checkpoint');
    // Start order: the database is ready before the app that needs it starts.
    for (const { name } of this.targets(plan, 'start')) {
      const original = plan.instances.find(i => i.name === name)!;
      const current = await read<Instance>(`/1.0/instances/${e(name)}`);
      if (current.config['volatile.base_image'] !== original.config['volatile.base_image']) throw new Error('Restored runtime differs from checkpoint');
      if (record.originalRunning[name]) {
        if (await containerState(name) !== 'Running') await startContainer(name);
        await waitForRunning(name);
        await waitForContainerExec(name);
        await this.waitReady(plan, name, plan.manifest);
      } else if (await containerState(name) !== 'Stopped') throw new Error('Original stopped state was not restored');
    }
  }
  async reopen(record: AppUpdateRecord): Promise<void> {
    if (this.noProviderEffects(record)) return;
    const plan = this.load(record);
    // No security comparison here: after a commit nothing old is restored, and a rollback compared in restore().
    // Recheck frozen runtime identity before starting any fenced workload.
    await this.bootFence(record, true);
    const pg = await this.postgres(record);
    const fence = this.optionalFence(record);
    if (pg && fence) {
      // Original grants are restored while ordinary app clients are stopped.
      for (const { name } of this.targets(plan, 'stop')) {
        await stopContainer(name, { timeoutSec: this.stopTimeout(plan, name) });
      }
      await pg.unfence(fence, 'original');
    }
    // Clean stops only: after a commit the data is live, so a container that will not stop leaves the reopen
    // pending (retried by recovery) instead of being killed.
    for (const { name } of this.targets(plan, 'stop')) {
      if (!record.originalRunning[name]) await stopContainer(name, { timeoutSec: this.stopTimeout(plan, name) });
    }
    // After a commit the new version runs: its databases and caches are ready by the installed (new) manifest's
    // checks. Before one, the old version was restored and the plan's manifest is the one that describes it.
    let manifest = plan.manifest;
    if (record.commit) {
      try {
        manifest = await readFrozenUpdateManifest(record.appId);
      } catch (error) {
        console.warn(`[app-update] ${record.appId} ${record.id}: the installed manifest could not be read for the reopen; `
          + 'checking readiness as the previous version declared it:', error);
      }
    }
    for (const { name } of this.targets(plan, 'start')) {
      if (record.originalRunning[name]) await this.startRuntime(record, name, manifest);
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
    await clearRecoveryLabels(record.id, names);
    this.workspace(record).remove();
  }
}

/** The MAC addresses Incus recorded for the original container's NICs (`volatile.<nic>.hwaddr`). */
function originalHardwareAddresses(original: Instance): Record<string, string> {
  return Object.fromEntries(Object.entries(original.config).filter(([key]) => /^volatile\.[^.]+\.hwaddr$/.test(key)));
}

const RECOVERY_LABELS = ['user.youeye.update_operation', 'user.youeye.update_source', 'user.youeye.update_restored'];

/**
 * A rollback renames its restored copy to the app's container name, and the copy's recovery labels came with it. They
 * prove identity during recovery only; once the operation is cleaned up they would make every later System update's
 * checkpoint refuse the container as "retained maintenance". Remove the labels of this operation (never another's).
 */
export async function clearRecoveryLabels(operationId: string, containerNames: string[]): Promise<void> {
  for (const name of containerNames) {
    const instance = await optionalInstance(name);
    if (!instance || !RECOVERY_LABELS.some(label => instance.config[label] === operationId)) continue;
    const config = { ...instance.config };
    for (const label of RECOVERY_LABELS) if (config[label] === operationId) delete config[label];
    if (config['user.youeye.update_source'] && !config['user.youeye.update_operation']) delete config['user.youeye.update_source'];
    await effect('PUT', `/1.0/instances/${e(name)}`, { ...instance, config });
  }
}

/**
 * An app's own database is checkpointed with its volumes, and those files only open with the same engine version and
 * extensions: an update that changes the engine's image is refused.
 */
export function assertOwnDatabaseEngineUnchanged(old: AppManifest, target: AppManifest): void {
  if (old.database?.mode !== 'own') return;
  const before = old.containers.find(c => c.name === old.database!.container);
  const after = target.containers.find(c => c.name === old.database!.container);
  if (!before || !after || before.image !== after.image || before.type !== after.type) {
    code('postgres-runtime-change-excluded', 'Update the PostgreSQL platform separately; app transactions retain the exact database runtime.');
  }
}

export async function prepareIncusAppUpdate(metadata: InstallMetadata, target: AppManifest) {
  const old = await readFrozenUpdateManifest(metadata.appId);
  if (old.version !== metadata.installedVersion) code('frozen-version-mismatch', 'Installed manifest and recorded runtime version disagree.');
  assertOwnDatabaseEngineUnchanged(old, target);
  const { observations, instances } = await observeUpdateInventory(metadata);
  let stateBytes = 32 * 1024 * 1024;
  const postgres = postgresScope(metadata, old);
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
    postgres, securityParts: await securityParts(metadata),
    capacity: { pools: observations.pools.map(p => ({ name: p.name, requiredBytes: p.checkpointBytes + p.cleanupReserveBytes })), stateBytes },
    volumeDescriptions };
  return { inventory, old, provider: new IncusAppUpdateProvider(plan),
    sourceArtifacts: [
      ...(metadata.nativeArtifacts?.map(a => a.sha256) ?? []),
      ...instances.flatMap(c => /@sha256:([a-f0-9]{64})/.exec(c.config['image.id'] ?? '')?.[1] ?? []),
    ],
    metadataBeforeSHA256: updateDigest(JSON.stringify(plan)) };
}
