import { fakeIncus, loadUpdateProvider } from './update-provider-harness';

export const OPERATION = '12345678-1234-4234-8234-123456789abc';
const CONTAINERS = ['app-fixture-main', 'app-fixture-worker', 'app-fixture-valkey', 'app-fixture-postgres'];

/**
 * An app with its own PostgreSQL (`database.mode: own`): app, worker, cache and database containers, one data volume
 * for the app and one for the engine, all running. `events` holds the fake Incus log plus readiness probes.
 */
export function ownDatabaseApp() {
  const incus = fakeIncus();
  for (const name of CONTAINERS) incus.addInstance(name, 'Running');
  incus.addVolume('ye-fixture-main-data', ['app-fixture-main', 'app-fixture-worker'], 'photos-1');
  incus.addVolume('ye-fixture-postgres-data', ['app-fixture-postgres'], 'rows-1');
  const metadata = {
    appId: 'fixture', installedVersion: '1.0.0', databaseMode: 'own',
    containers: [
      { name: 'main', containerName: 'app-fixture-main', type: 'oci', primary: true },
      { name: 'worker', containerName: 'app-fixture-worker', type: 'oci' },
      { name: 'valkey', containerName: 'app-fixture-valkey', type: 'oci', role: 'cache' },
      { name: 'postgres', containerName: 'app-fixture-postgres', type: 'oci', role: 'database' },
    ],
    storageVolumes: [
      { appId: 'fixture', containerName: 'app-fixture-main', pool: 'default', name: 'ye-fixture-main-data', logicalName: 'data', containerPath: '/data', readOnly: false },
      { appId: 'fixture', containerName: 'app-fixture-worker', pool: 'default', name: 'ye-fixture-main-data', logicalName: 'data', containerPath: '/data', readOnly: false },
      { appId: 'fixture', containerName: 'app-fixture-postgres', pool: 'default', name: 'ye-fixture-postgres-data', logicalName: 'pgdata', containerPath: '/var/lib/postgresql/data', readOnly: false },
    ],
  };
  const manifest = {
    metadata: { id: 'fixture' }, version: '1.0.0',
    database: { mode: 'own', container: 'postgres', name: 'fixture', user: 'fixture' },
    containers: [
      { name: 'main', type: 'oci', image: 'app:1', port: 2283, healthCheck: { type: 'http', path: '/ping' }, volumes: [] },
      { name: 'worker', type: 'oci', image: 'app:1', volumes: [] },
      { name: 'valkey', type: 'oci', image: 'valkey:8', volumes: [] },
      { name: 'postgres', type: 'oci', image: 'postgres:14-vector', volumes: [] },
    ],
  };
  const resources = [
    { kind: 'metadata', scope: 'market', name: 'fixture', mutable: true },
    ...CONTAINERS.map(name => ({ kind: 'container', scope: 'incus', name, mutable: true })),
    { kind: 'volume', scope: 'default', name: 'ye-fixture-main-data', mutable: true },
    { kind: 'volume', scope: 'default', name: 'ye-fixture-postgres-data', mutable: true },
  ];
  const plan = { metadata, manifest, instances: [...incus.instances.values()].map(i => structuredClone(i)),
    inventory: { resources }, volumeDescriptions: [...incus.volumes.values()].map(v => ({ pool: 'default', name: v.name, description: '' })) };
  const record = { id: OPERATION, appId: 'fixture', phase: 'quiescing', resources, checkpoints: [] as any[],
    steps: [{ id: 'initialize-recovery-plan', phase: 'preflight', state: 'completed' },
      { id: 'quiesce-writers', phase: 'quiescing', state: 'intent' }] as any[],
    originalRunning: Object.fromEntries(CONTAINERS.map(name => [name, true])) as Record<string, boolean>,
    commit: undefined as unknown, rollbackVerifiedAt: undefined as unknown };
  const events = incus.log;
  let installed = structuredClone(metadata);
  const { IncusAppUpdateProvider, assertOwnDatabaseEngineUnchanged } = loadUpdateProvider(incus, {
    './health': {
      waitForPostgresHealth: async (name: string, user: string) => { events.push(`pg_isready:${name}:${user}`); return true; },
      waitForAppHealth: async (name: string) => { events.push(`health:${name}`); return true; },
    },
    './metadata': { readInstallMetadata: async () => installed, saveInstallMetadata: async (m: typeof metadata) => { installed = m; } },
    './installed-apps': { restoreInstalledAppUpdateState: async () => {} },
    // The installed (frozen) manifest: the plan's until a test commits another version.
    './frozen-manifest': { readFrozenUpdateManifest: async () => plan.manifest },
    './ui-manifest-sync': { syncAppManifestObjectToUI: async () => {} },
    './update-workspace': { updateDigest: () => 'digest' },
  });
  const provider = new IncusAppUpdateProvider();
  provider.load = () => plan;
  provider.workspace = () => ({
    get: (name: string) => {
      if (name !== 'plan') throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return Buffer.from('plan');
    },
    put() {}, remove() {},
  });
  provider.ingress = async () => {};
  /** Quiesce, then checkpoint every mutable resource, as the transaction does. */
  async function prepare() {
    await provider.quiesce(record);
    record.steps[1].state = 'completed';
    record.phase = 'checkpointing';
    for (const resource of resources.filter(r => r.mutable)) record.checkpoints.push(await provider.checkpoint(record, resource));
    await provider.validateCheckpoints(record);
  }
  /** What a new version does while applying: runs, migrates the database, writes files. */
  function apply() {
    record.phase = 'applying';
    record.steps.push({ id: 'oci-replace-0', phase: 'applying', state: 'completed' });
    for (const name of CONTAINERS) incus.instances.get(name)!.status = 'Running';
    incus.instances.get('app-fixture-main')!.config['volatile.base_image'] = 'image-new';
    incus.volumes.get('ye-fixture-main-data')!.data = 'photos-2';
    incus.volumes.get('ye-fixture-postgres-data')!.data = 'rows-migrated';
  }
  return { incus, provider, record, plan, events, prepare, apply, assertOwnDatabaseEngineUnchanged, containers: CONTAINERS };
}
