/**
 * A server restore on a box in use (`POST /api/backup/restore` with `restoreCore`), end to end against a fake box.
 *
 * Real code: `full-restore.ts`, `service-credential-operations.ts`, `service-credential-bridge.ts`, the credential
 * lifecycle and store, the container maintenance locks, `app-network.ts` and the app network allocator
 * (`ipam.json` on disk). Faked: Incus, Spine, Caddy, Pi-hole, the databases, the dashboard's credential bridge
 * (its table in memory, checked with the same shared rules as the real one) and the app installer, which does
 * what the real one does for the network (reserve a lease, refused when the app already owns one; create the
 * bridge; activate) and for the service credential (prepare, publish, activate, mark ready).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as ipam from '../src/lib/incus/app-network-ipam';
import * as maintenance from '../src/lib/maintenance/container-maintenance';
import * as configEquality from '../src/lib/incus/config-equality';
import * as caddyNic from '../src/lib/incus/app-network-caddy-nic';
import * as deviceMergePatch from '../src/lib/incus/device-merge-patch';
import * as connectionNic from '../src/lib/incus/connection-nic';
import * as credentialLifecycle from '../src/lib/apps/service-credential-lifecycle';
import * as retainedRestore from '../src/lib/apps/service-credential-retained-restore';
import * as sharedCredential from '../../shared/app-service-credential';
import type { AppCredentialProjection } from '../../shared/app-service-credential';
import { AppServiceCredentialStore } from '../src/lib/apps/service-credential-store';
import type { FullRestoreConfig, FullRestoreProgress } from '../src/lib/backup/types';

const require = createRequire(import.meta.url);
const DATABASES = ['youeye', 'youeye_ui', 'pointer'];
const STOPPED_BY_RESTORE = ['youeye-caddy', 'youeye-pihole', 'youeye-pointer', 'youeye-ui'];
const CORE = [...STOPPED_BY_RESTORE, 'youeye-control', 'youeye-postgres'];
const NETWORK_CONFIG = { pools: ['10.76.0.0/16'], allocationPrefix: 27 };

interface AppRecord {
  appId: string;
  installationId: string;
  containers: Array<{ containerName: string }>;
  domain: string;
  subdomain: string;
  installedVersion: string;
  lifecycleState: 'active';
  enabled: boolean;
  desiredState: 'running' | 'stopped';
  serviceCredentialState: 'pending' | 'ready' | 'revoked';
  serviceCredentialDesiredState?: 'running' | 'stopped';
  enableSSO?: boolean;
  ssoClientId?: string;
  /** The YouEye ID client secret the app holds (in its environment or its own settings). */
  signInSecret?: string;
}

interface SignInClient {
  client_id: string; client_secret: string; name: string; redirect_uris: string[]; post_logout_redirect_uris: string[];
  backchannel_logout_uri: string | null; scopes: string[]; role_claim: null;
}

type DashboardCredentials = Array<[string, { projection: AppCredentialProjection; ready: boolean }]>;
type Archive =
  | { kind: 'core'; inventory: AppRecord[]; ipam: string | null; dashboard: DashboardCredentials; clients: SignInClient[] }
  | { kind: 'app'; record: AppRecord };

/** Load a source file as CommonJS with the given modules in place of its imports (timers do not wait). */
function load(file: string, dependencies: Record<string, unknown>, fetch: unknown = undefined): Record<string, any> {
  const filename = path.join(import.meta.dirname, '../src/lib', file);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'setTimeout', 'fetch', output)((name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith('node:') || ['fs', 'fs/promises', 'path', 'crypto', 'yaml'].includes(name)) return require(name);
    throw new Error(`Unexpected dependency ${name} in ${file}`);
  }, exports, (work: () => void) => setImmediate(work), fetch);
  return exports;
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'server-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const networks = path.join(directory, 'networks');
  const ipamPath = path.join(networks, 'ipam.json');
  const maintenanceDirectory = path.join(directory, 'maintenance');
  process.env.YOUEYE_APP_NETWORK_STATE_PATH = ipamPath;
  process.env.YOUEYE_CONTAINER_MAINTENANCE_DIR = maintenanceDirectory;
  process.env.YOUEYE_CONFIG_PATH = path.join(directory, 'youeye.yaml');
  process.env.UI_BRIDGE_TOKEN = 'fixture-bridge-token';

  const credentials = new AppServiceCredentialStore(path.join(directory, 'credentials'));
  const apps = new Map<string, AppRecord>();
  const containers = new Map<string, 'Running' | 'Stopped'>(CORE.map(name => [name, 'Running']));
  const bridges = new Set<string>();
  const archives = new Map<string, Archive>();
  const issues = new Map<string, { severity: string }>();
  const uninstalled: string[] = [];
  const appliedVolumes: string[] = [];
  // The dashboard's `app_service_credentials` table (in the `youeye_ui` database, so a core restore replaces it).
  let dashboard = new Map<string, { projection: AppCredentialProjection; ready: boolean }>();
  // The identity database: which installation owns which app and address, and the YouEye ID clients.
  let admission: Array<{ appId: string; installationId: string; host: string }> = [];
  let identityClients = new Map<string, SignInClient>();
  const fail = { restoreApp: new Set<string>(), databases: 0, database: new Map<string, number>(), quiesce: new Set<string>(),
    dashboard: false, caddy: 0 };
  // The encryption each archive was restored with (what the restore sent Spine, or passed to the app restore).
  const encryptions: Array<{ archive: string; encryption: unknown }> = [];
  // Called from inside the restore: while the core volumes are replaced, and when an app's restore has failed.
  const hooks: { replacingVolumes?: () => Promise<void>; appRestoreFailed?: () => void } = {};

  const leases = async () => existsSync(ipamPath) ? (await ipam.readIpamState({ config: NETWORK_CONFIG })).leases : [];
  const requireRunning = (name: string, message: string) => {
    if (containers.get(name) !== 'Running') throw new Error(message);
  };

  function record(appId: string, overrides: Partial<AppRecord> = {}): AppRecord {
    return {
      appId, installationId: randomUUID(), containers: [{ containerName: `app-${appId}` }], domain: 'box.test',
      subdomain: appId, installedVersion: '1.0.0', lifecycleState: 'active', enabled: true, desiredState: 'running',
      serviceCredentialState: 'ready', ...overrides,
    };
  }

  /** The network part is the installer's: reserve (refused when the app already owns a network), create, activate. */
  async function install(app: AppRecord): Promise<void> {
    const lease = await ipam.mutateIpamState({ config: NETWORK_CONFIG, allowInitialize: true }, state =>
      ipam.reserveLease(state, { appId: app.appId, operationId: randomUUID(), requiredAddresses: 8, observedBridgeNames: [...bridges] }));
    bridges.add(lease.bridgeName);
    await ipam.mutateIpamState({ config: NETWORK_CONFIG }, state => ipam.transitionLease(state, app.appId, 'active'));
    for (const container of app.containers) {
      containers.set(container.containerName, app.desiredState === 'running' ? 'Running' : 'Stopped');
    }
    apps.set(app.appId, structuredClone(app));
    admission = [...admission.filter(row => row.appId !== app.appId),
      { appId: app.appId, installationId: app.installationId, host: `${app.subdomain}.${app.domain}` }];
    if (app.enableSSO) remakeSignInClient(app.appId);
    await credentialLifecycle.prepareCredentialForAppInstall(app.appId, credentials);
  }

  /** What every install does for an app with sign-in: a client with a new secret, handed to the app. */
  function remakeSignInClient(appId: string): void {
    const app = apps.get(appId)!;
    const secret = randomUUID();
    identityClients.set(app.ssoClientId!, {
      client_id: app.ssoClientId!, client_secret: secret, name: appId, redirect_uris: [`https://${app.subdomain}.${app.domain}/callback`],
      post_logout_redirect_uris: [], backchannel_logout_uri: null, scopes: ['openid'], role_claim: null,
    });
    app.signInSecret = secret;
  }
  /** YouEye ID accepts the app's token request only with the secret of its client row. */
  const signInWorks = (appId: string) => {
    const app = apps.get(appId)!;
    return Boolean(app.signInSecret) && identityClients.get(app.ssoClientId!)?.client_secret === app.signInSecret;
  };

  /** A Market install. Its last step publishes and activates the credential; a refusal leaves the app pending. */
  async function installFromMarket(app: AppRecord): Promise<void> {
    await install(app);
    try {
      await bridge.activateProvisionedCredential(app.appId);
    } catch {
      apps.set(app.appId, { ...structuredClone(app), enabled: false, desiredState: 'stopped',
        serviceCredentialState: 'pending', serviceCredentialDesiredState: 'running' });
      await quiesce(app.containers.map(container => container.containerName));
      throw new Error('App service integration is pending; reconcile credentials');
    }
    if (app.desiredState === 'stopped') await quiesce(app.containers.map(container => container.containerName));
  }

  /** Like the uninstaller: the credential is revoked at the dashboard before anything is removed. */
  async function uninstall(appId: string): Promise<void> {
    const app = apps.get(appId);
    if (!app) throw new Error(`${appId} is not installed`);
    await bridge.revokeAppCredential(appId);
    for (const container of app.containers) containers.delete(container.containerName);
    const lease = (await leases()).find(candidate => candidate.appId === appId);
    if (lease) {
      bridges.delete(lease.bridgeName);
      await ipam.mutateIpamState({ config: NETWORK_CONFIG }, state => { ipam.releaseLease(state, appId); });
    }
    if (app.ssoClientId) identityClients.delete(app.ssoClientId);
    apps.delete(appId);
    admission = admission.filter(row => row.appId !== appId);
  }

  let sets = 0;
  /** A backup set of the box as it is now: the core (with its copy of the allocator) and one archive per app. */
  async function backup(options: { encryption?: unknown } = {}): Promise<{ backupPath: string; apps: string[] }> {
    const backupPath = path.join(directory, 'sets', `set-${++sets}`);
    if (options.encryption !== undefined) {
      await mkdir(backupPath, { recursive: true });
      await writeFile(path.join(backupPath, 'backup-set.json'), JSON.stringify({ schema: 'youeye.backup.set.v1', encryption: options.encryption }));
    }
    const core = path.join(backupPath, 'youeye/core/core-2026-11-19.tar.enc');
    await mkdir(path.dirname(core), { recursive: true });
    await writeFile(core, 'encrypted');
    archives.set(core, { kind: 'core', inventory: [...apps.values()].map(app => structuredClone(app)),
      ipam: existsSync(ipamPath) ? await readFile(ipamPath, 'utf8') : null, dashboard: structuredClone([...dashboard]),
      clients: structuredClone([...identityClients.values()]) });
    for (const app of apps.values()) {
      const archive = path.join(backupPath, 'youeye/apps', app.appId, `${app.appId}-2026-11-19.tar.enc`);
      await mkdir(path.dirname(archive), { recursive: true });
      await writeFile(archive, 'encrypted');
      archives.set(archive, { kind: 'app', record: structuredClone(app) });
    }
    return { backupPath, apps: [...apps.keys()] };
  }
  const appArchive = (set: { backupPath: string }, appId: string) =>
    path.join(set.backupPath, 'youeye/apps', appId, `${appId}-2026-11-19.tar.enc`);

  const spineClient = {
    restoreArchive: async ({ archive_path: archivePath, staging_dir: staging, encryption }: { archive_path: string; staging_dir: string; encryption?: unknown }) => {
      encryptions.push({ archive: archivePath, encryption });
      const archive = archives.get(archivePath);
      assert.ok(archive?.kind === 'core');
      const files: Record<string, string> = {
        'backup-meta.json': JSON.stringify({
          schema: 'youeye.backup.core-meta.v1', type: 'core', admissionSchemaVersion: 1, databases: DATABASES, source: {},
        }),
        'configs/youeye-config.json': JSON.stringify({ domain: 'box.test' }),
        'caddy/caddy-config.json': '{}', 'pihole/pihole.toml': 'fixture',
        'installed-apps.json': JSON.stringify(archive.inventory),
        'volume-map.json': JSON.stringify({ schema: 'youeye.backup.volume-map.v1', volumes: [
          { source: '/var/lib/youeye/config', archive_path: 'volumes/1-config' },
          { source: '/var/lib/youeye/networks', archive_path: 'volumes/2-networks' },
        ] }),
        ...Object.fromEntries(DATABASES.map(database => [`databases/${database}-2026-11-19.sql`,
          JSON.stringify(database === 'youeye_ui' ? archive.dashboard : { apps: archive.inventory, clients: archive.clients })])),
      };
      for (const [name, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
        await writeFile(path.join(staging, name), content);
      }
      await mkdir(path.join(staging, 'volumes/1-config'), { recursive: true });
      await mkdir(path.join(staging, 'volumes/2-networks'), { recursive: true, mode: 0o700 });
      if (archive.ipam !== null) await writeFile(path.join(staging, 'volumes/2-networks/ipam.json'), archive.ipam, { mode: 0o600 });
    },
    /** Like Spine: each path the volume map names is replaced by the archive's copy. */
    applyBackupVolumes: async (staging: string) => {
      const map = JSON.parse(await readFile(path.join(staging, 'volume-map.json'), 'utf8')) as {
        volumes: Array<{ source: string; archive_path: string }>;
      };
      await hooks.replacingVolumes?.();
      for (const volume of map.volumes) {
        appliedVolumes.push(volume.source);
        if (volume.source !== '/var/lib/youeye/networks') continue;
        await rm(networks, { recursive: true, force: true });
        await cp(path.join(staging, volume.archive_path), networks, { recursive: true });
        await chmod(networks, 0o700);
        if (existsSync(ipamPath)) await chmod(ipamPath, 0o600);
      }
    },
    setConfig: async () => {},
  };

  const incus = {
    incusRequest: async (method: string, url: string, body?: { action?: string }) => {
      const notFound = { type: 'error', status_code: 404, error_code: 404, error: 'not found' };
      const ok = (metadata: unknown = {}) => ({ type: 'sync', status_code: 200, metadata });
      const [, kind, encoded, action] = /^\/1\.0\/(instances|networks|network-acls)\/([^/]+)(?:\/(state))?$/.exec(url) ?? [];
      const name = decodeURIComponent(encoded ?? '');
      if (kind === 'network-acls' && method === 'GET') return notFound;
      if (kind === 'networks') {
        if (!bridges.has(name)) return notFound;
        if (method === 'DELETE') bridges.delete(name);
        return ok({ name, managed: true, config: {} });
      }
      if (kind === 'instances') {
        if (!containers.has(name)) return notFound;
        if (action === 'state' && method === 'PUT') {
          containers.set(name, body?.action === 'start' ? 'Running' : 'Stopped');
          return ok();
        }
        if (method === 'GET') return ok({ name, status: containers.get(name), config: {}, devices: {}, profiles: [] });
        return ok();
      }
      throw new Error(`Unexpected Incus request ${method} ${url}`);
    },
    execCommand: async (name: string) => ({ exitCode: containers.get(name) === 'Running' ? 0 : 1, stdout: '', stderr: '' }),
    execShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    incusUploadFile: async (name: string) => requireRunning(name, `${name} is not running`),
  };

  const quiesce = async (names: string[]) => {
    if (names.some(name => fail.quiesce.has(name))) throw new Error('App runtime quiescence requires repair');
    for (const name of names) if (containers.has(name)) containers.set(name, 'Stopped');
  };
  const metadata = {
    listInstalledApps: async () => [...apps.values()].map(app => structuredClone(app)),
    listRetainedApps: async () => [],
    readInstallMetadata: async (appId: string) => apps.has(appId) ? structuredClone(apps.get(appId)!) : null,
    saveInstallMetadata: async (app: AppRecord) => { apps.set(app.appId, structuredClone(app)); },
  };
  /** The dashboard's bridge endpoints over its table, with the shared rules the real ones apply. */
  const dashboardFetch = async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    if (containers.get('youeye-ui') !== 'Running' || fail.dashboard) throw new Error('connect ECONNREFUSED');
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.pathname === '/api/apps/v1/credential-probe') {
      const appId = init.headers?.['X-YouEye-App'] ?? '';
      const secret = (init.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const known = await credentials.authenticate(appId, secret);
      const row = dashboard.get(appId);
      return answer(known && row?.projection.status === 'active' && row.projection.revision === known.revision ? 200 : 401, {});
    }
    const [, encoded, action] = /^\/api\/ui-bridge\/app-credentials\/([^/]+)(?:\/(ready|restore-fence))?$/.exec(url.pathname) ?? [];
    if (!encoded || init.headers?.['X-UI-Bridge-Token'] !== 'fixture-bridge-token') return answer(401, {});
    const appId = decodeURIComponent(encoded);
    const row = dashboard.get(appId);
    try {
      if (action === 'restore-fence' && !init.method) return answer(200, { credential: row?.projection ?? null });
      if (action === 'restore-fence') {
        if (sharedCredential.checkAppCredentialRestoreFence(row?.projection ?? null, body.credential, body.expected) === 'apply') {
          dashboard.set(appId, { projection: sharedCredential.parseAppCredentialProjection(body.credential), ready: false });
        }
        return answer(200, { ok: true, revision: body.credential.revision });
      }
      if (action === 'ready') {
        const credential = row?.projection;
        if (!credential || credential.status !== 'active' || credential.installationId !== body.installationId
          || credential.revision !== body.revision || credential.generation !== body.generation) return answer(409, {});
        row.ready = body.ready !== false;
        return answer(200, { ok: true });
      }
      const { result, credential } = sharedCredential.checkAppCredentialBatch(row?.projection ?? null, body.credentials, body.expectedRevision);
      // Like the dashboard: only an app it has registered can get a credential that is not a revocation.
      if (result === 'apply' && !apps.has(appId) && credential.status !== 'revoked') return answer(409, {});
      if (result === 'apply') dashboard.set(appId, { projection: credential, ready: false });
      return answer(200, { ok: true, result, appId, installationId: credential.installationId,
        generation: credential.generation, revision: credential.revision, status: credential.status });
    } catch {
      return answer(409, { error: 'conflict' });
    }
  };
  const bridge = load('apps/service-credential-bridge.ts', {
    '@/lib/incus/container-ip': { getContainerIP: async (name: string) => containers.get(name) === 'Running' ? '10.0.0.9' : null },
    './service-credential-store': { appServiceCredentials: credentials },
    '../../../../shared/app-service-credential': sharedCredential,
    './service-credential-retained-restore': retainedRestore,
  }, dashboardFetch);
  const updateAdmission = {
    withAppInventory: (work: () => unknown) => work(),
    withAppLifecycle: (_appId: string, work: () => unknown) => work(),
    withAppLifecycles: (_appIds: string[], work: () => unknown) => work(),
    isAppUpdateReserved: () => false,
    AppLifecycleAdmissionError: class extends Error {},
  };
  const pihole = {
    getDNSRecords: async () => { requireRunning('youeye-pihole', 'Pi-hole is not running'); return []; },
    getCNAMERecords: async () => [], removeCNAMERecord: async () => {}, removeDNSRecord: async () => {},
  };

  const appNetwork = load('incus/app-network.ts', {
    '@/lib/market/install-tracker': { describeErrorChainForLog: String },
    './server': incus, './config-equality': configEquality, './app-network-caddy-nic': caddyNic,
    './device-merge-patch': deviceMergePatch, './connection-nic': connectionNic, './app-network-ipam': ipam,
    './container-ip': { getContainerIP: async () => '10.0.0.2', hostSideNICAddress: async () => null },
    './static-ips': { getSystemStaticIP: async () => null },
    '@/lib/health/issues': {
      assertNoCriticalIssues: async () => {},
      observeIssue: async (issue: { id: string; severity: string }) => { issues.set(issue.id, issue); },
      resolveIssue: async (id: string) => { issues.delete(id); },
    },
    '@/lib/spine/client': { spineClient }, '@/lib/market/update-admission': updateAdmission,
    './snapshot': load('incus/snapshot.ts', { './server': incus, '../infrastructure/image-fetch-retry': {} }),
    '@/lib/apps/container-order': load('apps/container-order.ts', {}),
  });

  const operations = load('apps/service-credential-operations.ts', {
    '../market/update-admission': updateAdmission,
    './service-credential-store': { appServiceCredentials: credentials },
    './service-credential-lifecycle': credentialLifecycle,
    './service-credential-bridge': bridge,
    './service-credential-runtime': { assertPrivateCredentialConfig: () => {}, rewriteCredentialEnvironment: (text: string) => text },
    './service-credential-probe': { probeNativeAppCredential: async () => {}, quiesceAppCredentialRuntime: quiesce },
    '../market/metadata': metadata,
    '../market/frozen-manifest': {
      readFrozenUpdateManifest: async (appId: string) => ({
        metadata: { id: appId }, containers: [{ name: 'main', type: 'oci' }], configFiles: [], secrets: [], env_mapping: {},
      }),
    },
    '../admission/lifecycle': { bindInstalledAdmission: async () => {} },
    '../admission/projection': { reconcileAdmissionProjections: async () => {} },
    '../market/platform-env': { buildCanonicalContext: async () => ({}), resolveEnvMapping: () => ({}) },
    '../market/engine-helpers': { getContainerName: (appId: string) => `app-${appId}` },
    '../market/variables': { resolveEnvironment: () => ({}) },
    '../market/config-writer': { writeAllConfigFiles: async () => {} },
    '../infrastructure/secrets': { readAppSecret: async () => 'secret' },
    '../incus/app-network': appNetwork,
    '../maintenance/container-maintenance': maintenance,
    '../incus/server': incus,
    '../incus/snapshot': {
      startContainer: async (name: string) => {
        if (!containers.has(name)) throw new Error(`${name} does not exist`);
        containers.set(name, 'Running');
      },
      waitForRunning: async () => {}, waitForOperation: async () => {},
    },
  });

  const restore = load('backup/full-restore.ts', {
    '@/lib/spine/client': { spineClient },
    '@/lib/incus/server': incus,
    '@/lib/incus/app-network': appNetwork,
    '@/lib/caddy/client': {
      getRoutes: async () => [], removeRoute: async () => {},
      setConfig: async () => {
        if (fail.caddy > 0) { fail.caddy--; throw new Error('Caddy refused the configuration'); }
        requireRunning('youeye-caddy', 'Caddy is not running');
      },
    },
    '@/lib/market/update-admission': updateAdmission,
    '@/lib/market/install-tracker': { logOperationFailure: () => {} },
    './app-restore': {
      /** Replaces the app with its archive: a current installation goes first, then the installer runs. */
      restoreApp: async (config: { appId: string; archivePath: string; encryption?: unknown }, _onEvent: unknown, _protectCurrentState?: boolean) => {
        encryptions.push({ archive: config.archivePath, encryption: config.encryption });
        const archive = archives.get(config.archivePath);
        assert.ok(archive?.kind === 'app' && archive.record.appId === config.appId);
        if (fail.restoreApp.has(config.archivePath)) {
          hooks.appRestoreFailed?.();
          throw new Error(`${config.appId} did not pass its post-restore health check`);
        }
        if (apps.has(config.appId)) await uninstall(config.appId);
        await bridge.prepareRestoredAppCredential(config.appId);
        await install({ ...archive.record, serviceCredentialState: 'pending', serviceCredentialDesiredState: archive.record.desiredState });
        await operations.operateAppCredential(config.appId, { action: 'reconcile' });
      },
    },
    '@/lib/market/metadata': metadata,
    '@/lib/market/uninstaller': {
      uninstallApp: async (appId: string, options: { keepData?: boolean }) => {
        assert.equal(options.keepData, false);
        uninstalled.push(appId);
        await uninstall(appId);
        return { success: true, errors: [] };
      },
      deregisterAppFromUI: async () => {},
    },
    '@/lib/market/reconciler': { isAppRegisteredWithUI: async () => false },
    '@/lib/admission/store': {
      getAdmissionPolicy: async (appId: string) => admission.find(row => row.appId === appId) ?? null,
    },
    '@/lib/identity/store': {
      identitySql: (value: string) => `'${value}'`,
      identityRows: async (sql: string) => {
        const host = /host = '([^']+)'/.exec(sql)?.[1];
        const client = /FROM admission_clients WHERE client_id = '([^']+)'/.exec(sql)?.[1];
        return admission.filter(row => client ? `youeye-app-${row.appId}` === client : row.host === host)
          .map(row => ({ installation_id: row.installationId }));
      },
      identityCommand: async () => {}, refreshIdentitySchemaAfterRestore: async () => {},
      getClient: async (clientId: string) => structuredClone(identityClients.get(clientId) ?? null),
      ensureClient: async (input: { clientId: string; clientSecret: string; name: string; redirectUris: string[];
        postLogoutRedirectUris?: string[]; backchannelLogoutUri?: string | null; scopes: string[] }) => {
        identityClients.set(input.clientId, { client_id: input.clientId, client_secret: input.clientSecret, name: input.name,
          redirect_uris: input.redirectUris, post_logout_redirect_uris: input.postLogoutRedirectUris ?? [],
          backchannel_logout_uri: input.backchannelLogoutUri ?? null, scopes: input.scopes, role_claim: null });
      },
    },
    '@/lib/market/installed-apps': { getInstalledApp: async () => null, removeInstalledApp: async () => {} },
    '../../../../shared/admission': { isUuid: (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) },
    '@/lib/apps/service-credential-probe': { quiesceAppCredentialRuntime: quiesce },
    '@/lib/identity/provider': {
      removeForwardAuth: async () => {}, removeOAuthClient: async (clientId: string) => { identityClients.delete(clientId); },
    },
    './workspace': {
      BACKUP_STAGING_ROOT: path.join(directory, 'staging'),
      runningContainers: async (names: string[]) => [...new Set(names)].filter(name => containers.get(name) === 'Running').sort(),
    },
    './postgres': {
      PLATFORM_DATABASES: DATABASES, isPlatformDatabase: (name: string) => DATABASES.includes(name),
      replacePlatformDatabase: async (name: string, dump: Buffer) => {
        if (fail.databases > 0) { fail.databases--; throw new Error('SQL import failed'); }
        if ((fail.database.get(name) ?? 0) > 0) {
          fail.database.set(name, fail.database.get(name)! - 1);
          throw new Error('SQL import failed');
        }
        if (name === 'youeye_ui') dashboard = new Map(JSON.parse(dump.toString('utf8')) as DashboardCredentials);
        if (name !== 'youeye') return;
        const identity = JSON.parse(dump.toString('utf8')) as { apps: AppRecord[]; clients: SignInClient[] };
        admission = identity.apps.map(app => (
          { appId: app.appId, installationId: app.installationId, host: `${app.subdomain}.${app.domain}` }));
        identityClients = new Map(identity.clients.map(client => [client.client_id, client]));
      },
      // Every restored credential row is denied before the UI starts again.
      suspendRestoredAppCredentials: async () => { for (const row of dashboard.values()) row.ready = false; },
      listRestoredAppCredentialIds: async () => [...dashboard.keys()].sort(),
    },
    './compatibility': {
      readCurrentBackupSourceIdentity: async () => ({}), assessBackupCompatibility: () => ({ compatible: true }),
    },
    '@/lib/apps/pihole-api': pihole, '../apps/pihole-api': pihole,
    '@/lib/identity/config': {}, '@/lib/identity/core-clients': {}, '@/lib/acme/storage': {}, '@/lib/infrastructure/deployer': {},
    './retained-apps': { readRetainedAppInventory: async () => [], restoreRetainedApps: async () => {} },
    '@/lib/apps/service-credential-bridge': bridge,
    '@/lib/apps/service-credential-operations': operations,
    '@/lib/maintenance/container-maintenance': maintenance,
    '@/lib/apps/service-credential-store': { appServiceCredentials: credentials },
  });

  // The watchdog's start of one container, as its tick calls it (the real gate, under the container's lifecycle).
  const watchdog = load('apps/app-reconciler.ts', {
    '../market/update-admission': { isUserOperationWaiting: () => false,
      withContainerLifecycle: (_name: string, work: () => unknown) => work() },
    '../maintenance/container-maintenance': maintenance,
    '../market/metadata': metadata,
    '../market/storage': { inspectAppStorage: async () => ({ available: true }) },
    '../incus/server': incus,
    '../infrastructure/oci-deployer': { waitForIncusOperation: async () => {} },
    './container-order': load('apps/container-order.ts', {}),
    './container-readiness': load('apps/container-readiness.ts', {}),
    '../incus/snapshot': load('incus/snapshot.ts', { './server': incus, '../infrastructure/image-fetch-retry': {} }),
  });

  /** Every lease is an active one of an installed app with its bridge, and every bridge has its lease. */
  async function assertNetworksMatchApps(): Promise<void> {
    const current = await leases();
    assert.deepEqual(current.map(lease => lease.appId).sort(), [...apps.keys()].sort(), 'one network per installed app, none for an absent app');
    assert.ok(current.every(lease => lease.state === 'active'));
    assert.deepEqual(current.map(lease => lease.bridgeName).sort(), [...bridges].sort());
    assert.equal(new Set(current.map(lease => lease.cidr)).size, current.length);
  }
  /** What the credential store and the dashboard each hold for an app: they must name the same record. */
  async function credentialSides(appId: string) {
    const side = (projection?: AppCredentialProjection | null) => projection
      ? { status: projection.status, revision: projection.revision, installationId: projection.installationId } : null;
    return { store: side(await credentials.projection(appId)), dashboard: side(dashboard.get(appId)?.projection) };
  }
  const forgetCredential = (appId: string) => rm(path.join(directory, 'credentials', appId), { recursive: true });
  const heldMaintenance = () => existsSync(path.join(maintenanceDirectory, 'locks'))
    ? readdirSync(path.join(maintenanceDirectory, 'locks')) : [];
  const fullRestore = (config: FullRestoreConfig) => restore.fullRestore(config, () => {}) as Promise<void>;
  const rollBackRestore = (failed: { passphrase: string; appIds: string[]; progress: FullRestoreProgress },
    preRestore: { backupPath: string; apps: string[] }) =>
    restore.rollBackRestore(failed, preRestore, () => {}) as Promise<'unchanged' | 'recovered'>;
  const startWatchdogContainer = watchdog.startWatchdogContainer as (name: string) => Promise<boolean>;
  const rollbackRestoreConfig = restore.rollbackRestoreConfig as (
    failed: { passphrase: string; appIds: string[]; progress: FullRestoreProgress },
    preRestore: { backupPath: string; apps: string[] }) => FullRestoreConfig | null;

  return {
    apps, containers, bridges, issues, uninstalled, appliedVolumes, fail, credentials, operations, ipamPath,
    dashboard: () => dashboard, credentialSides, forgetCredential, record, install: installFromMarket, uninstall,
    remakeSignInClient, signInWorks, hooks, rollBackRestore, startWatchdogContainer, restoreApps: (config: Pick<FullRestoreConfig, 'backupPath' | 'passphrase' | 'appIds'>) =>
      restore.restoreApps(config, () => {}) as Promise<void>, backup, appArchive, leases, assertNetworksMatchApps, heldMaintenance,
    fullRestore, rollbackRestoreConfig, encryptions,
  };
}

const passphrase = 'fixture-recovery-key';
const state = (f: Awaited<ReturnType<typeof fixture>>, appId: string) => {
  const app = f.apps.get(appId)!;
  return { container: f.containers.get(`app-${appId}`), enabled: app.enabled, desired: app.desiredState, credential: app.serviceCredentialState };
};
const running = { container: 'Running', enabled: true, desired: 'running', credential: 'ready' };

test('a restore that keeps apps reconciles their credentials under the maintenance lease it already holds', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'notes', 'wiki']) await f.install(f.record(appId));
  // An app its owner turned off, with a remembered "running" from an earlier credential operation.
  await f.install(f.record('cinema', { enabled: false, desiredState: 'stopped', serviceCredentialDesiredState: 'running' }));
  const set = await f.backup();
  const before = await f.leases();

  await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'] });

  assert.deepEqual([...f.apps.keys()].sort(), ['cinema', 'memos', 'notes', 'wiki']);
  assert.deepEqual(f.uninstalled, ['memos'], 'only the app being restored is removed');
  for (const appId of ['memos', 'notes', 'wiki']) assert.deepEqual(state(f, appId), running, appId);
  assert.deepEqual(state(f, 'cinema'), { container: 'Stopped', enabled: false, desired: 'stopped', credential: 'ready' },
    'an app that was turned off stays off');
  for (const appId of ['notes', 'wiki', 'cinema']) {
    assert.equal(f.dashboard().get(appId)?.ready, true);
    assert.deepEqual((await f.leases()).find(lease => lease.appId === appId), before.find(lease => lease.appId === appId),
      'a kept app keeps its network');
  }
  assert.deepEqual(f.heldMaintenance(), [], 'every maintenance lease is released');
  assert.ok(!f.appliedVolumes.includes('/var/lib/youeye/networks'));
  await f.assertNetworksMatchApps();
});

test('a held maintenance lease must be held and cover the app', async t => {
  const f = await fixture(t);
  await f.install(f.record('memos'));
  await f.install(f.record('notes'));
  const other = maintenance.beginContainerMaintenance(['app-notes'], { operation: 'test' });
  await assert.rejects(f.operations.operateAppCredential('memos', { action: 'reconcile' }, { maintenance: other }),
    /does not cover this app/);
  other.release();
  const own = maintenance.beginContainerMaintenance(['app-memos'], { operation: 'test' });
  await f.operations.operateAppCredential('memos', { action: 'reconcile' }, { maintenance: own });
  assert.equal(own.isHeld(), true, 'the lease stays with its holder');
  assert.deepEqual(f.heldMaintenance(), ['app-memos.lock']);
  own.release();
  await assert.rejects(f.operations.operateAppCredential('memos', { action: 'reconcile' }, { maintenance: own }),
    /does not cover this app/);
  // Without a held lease it takes its own, and a second holder is refused as before.
  await f.operations.operateAppCredential('memos', { action: 'reconcile' });
  const busy = maintenance.beginContainerMaintenance(['app-memos'], { operation: 'test' });
  await assert.rejects(f.operations.operateAppCredential('memos', { action: 'reconcile' }), /already active/);
  busy.release();
});

test('restoring the only app does not bring back the network the backup recorded for it', async t => {
  const f = await fixture(t);
  await f.install(f.record('memos'));
  const set = await f.backup();

  await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'] });

  assert.deepEqual(state(f, 'memos'), running);
  assert.ok(!f.appliedVolumes.includes('/var/lib/youeye/networks'), "the backup's allocator is never applied");
  assert.ok(f.appliedVolumes.includes('/var/lib/youeye/config'));
  await f.assertNetworksMatchApps();
});

test('a core restore does not bring back the network of an app that is no longer installed', async t => {
  const f = await fixture(t);
  const memos = f.record('memos');
  await f.install(memos);
  const set = await f.backup();
  await f.uninstall('memos');
  assert.deepEqual(await f.leases(), []);

  await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: [] });

  assert.deepEqual(await f.leases(), [], 'no allocation for an absent app');
  // The app installs again like any other.
  await f.install(memos);
  await f.assertNetworksMatchApps();
});

for (const bridgeLeft of [false, true]) {
  test(`a network left to an absent app is released before the app is restored (bridge ${bridgeLeft ? 'left too' : 'gone'})`, async t => {
    const f = await fixture(t);
    await f.install(f.record('memos'));
    await f.install(f.record('wiki'));
    const set = await f.backup();
    // What a restore before 0.6.13 left behind: the app gone, its lease still active.
    const allocator = await readFile(f.ipamPath, 'utf8');
    const bridge = (await f.leases()).find(lease => lease.appId === 'memos')!.bridgeName;
    await f.uninstall('memos');
    await writeFile(f.ipamPath, allocator, { mode: 0o600 });
    if (bridgeLeft) f.bridges.add(bridge);
    f.issues.set('market.app-network.memos', { severity: 'critical' });

    await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'] });

    assert.deepEqual(state(f, 'memos'), running);
    assert.deepEqual(state(f, 'wiki'), running);
    assert.equal(f.issues.has('market.app-network.memos'), false);
    await f.assertNetworksMatchApps();
  });
}

test('a failed restore is rolled back without removing any app that was not being restored', async t => {
  const f = await fixture(t);
  for (const appId of ['actual-budget', 'memos', 'notes', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  const installations = new Map([...f.apps.values()].map(app => [app.appId, app.installationId]));

  // What the restore route does: a pre-restore backup, the restore, and on failure the rollback.
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  f.fail.restoreApp.add(f.appArchive(set, 'notes'));
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos', 'notes'], progress }),
    /Failed to restore notes/);
  assert.equal(progress.changed, true);
  assert.deepEqual([...f.apps.keys()].sort(), ['actual-budget', 'memos', 'wiki'], 'notes was being replaced when it failed');
  assert.equal(state(f, 'wiki').container, 'Stopped', 'a failed restore leaves the kept apps stopped, not removed');
  assert.deepEqual(f.heldMaintenance(), []);

  const rollback = f.rollbackRestoreConfig({ passphrase, appIds: ['memos', 'notes'], progress }, preRestore);
  assert.deepEqual(rollback, { backupPath: preRestore.backupPath, passphrase, appIds: ['memos', 'notes'], discardAppIds: [],
    stoppedServices: ['youeye-caddy', 'youeye-pihole', 'youeye-pointer', 'youeye-ui'], keptAppClients: [] });
  await f.fullRestore(rollback!);

  assert.deepEqual([...f.apps.keys()].sort(), ['actual-budget', 'memos', 'notes', 'wiki'], 'no fewer apps than before the restore');
  for (const appId of f.apps.keys()) {
    assert.deepEqual(state(f, appId), running, appId);
    assert.equal(f.apps.get(appId)!.installationId, installations.get(appId));
  }
  assert.ok(f.uninstalled.every(appId => ['memos', 'notes'].includes(appId)), `removed: ${f.uninstalled.join(', ')}`);
  assert.deepEqual(f.heldMaintenance(), []);
  await f.assertNetworksMatchApps();
});

test('the rollback removes an app the failed restore added and puts back the one it was replacing', async t => {
  const f = await fixture(t);
  for (const appId of ['actual-budget', 'memos', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  await f.uninstall('actual-budget');

  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['actual-budget', 'memos'], progress }),
    /Failed to restore memos/);
  assert.deepEqual([...f.apps.keys()].sort(), ['actual-budget', 'wiki']);

  const rollback = f.rollbackRestoreConfig({ passphrase, appIds: ['actual-budget', 'memos'], progress }, preRestore)!;
  assert.deepEqual(rollback.appIds, ['memos']);
  assert.deepEqual(rollback.discardAppIds, ['actual-budget']);
  await f.fullRestore(rollback);

  assert.deepEqual([...f.apps.keys()].sort(), ['memos', 'wiki'], 'the box has the apps it had before the restore');
  assert.deepEqual(state(f, 'memos'), running);
  assert.deepEqual(state(f, 'wiki'), running);
  assert.ok(!f.uninstalled.includes('wiki'));
  await f.assertNetworksMatchApps();
});

test('an app that cannot be restored does not cost the apps after it, in the restore or in its rollback', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'notes', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  // memos can be restored from neither set (before 0.6.13: its setup/install.yaml failed on restored data).
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));
  f.fail.restoreApp.add(f.appArchive(preRestore, 'memos'));

  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos', 'notes'], progress }),
    /^Error: Failed to restore memos: /);
  assert.deepEqual([...f.apps.keys()].sort(), ['notes', 'wiki'], 'notes is restored although memos, before it, failed');

  await assert.rejects(f.fullRestore(f.rollbackRestoreConfig({ passphrase, appIds: ['memos', 'notes'], progress }, preRestore)!),
    /^Error: Failed to restore memos: /);
  assert.deepEqual([...f.apps.keys()].sort(), ['notes', 'wiki'], 'the failed rollback still puts notes back and keeps wiki');
  assert.deepEqual(state(f, 'notes'), running);
  assert.ok(!f.uninstalled.includes('wiki'));
  // The app that is missing can be installed, or restored once its archive can be.
  f.fail.restoreApp.clear();
  await f.fullRestore({ backupPath: preRestore.backupPath, passphrase, appIds: ['memos'] });
  assert.deepEqual([...f.apps.keys()].sort(), ['memos', 'notes', 'wiki']);
  for (const appId of f.apps.keys()) assert.deepEqual(state(f, appId), running, appId);
  await f.assertNetworksMatchApps();
});

test('the rollback starts the core services a failed restore left stopped', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  f.fail.databases = 1;

  // The real failure is reported: the stopped UI cannot be told about the kept apps and need not be.
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], progress }),
    /Failed to restore youeye: Error: SQL import failed/);
  for (const name of STOPPED_BY_RESTORE) assert.equal(f.containers.get(name), 'Stopped', `${name} stays closed after a failed database restore`);
  assert.deepEqual(progress.stoppedServices, STOPPED_BY_RESTORE);
  assert.deepEqual([...f.apps.keys()], ['wiki'], 'the kept app is still installed');

  await f.fullRestore(f.rollbackRestoreConfig({ passphrase, appIds: ['memos'], progress }, preRestore)!);

  for (const name of CORE) assert.equal(f.containers.get(name), 'Running', name);
  assert.deepEqual([...f.apps.keys()].sort(), ['memos', 'wiki']);
  assert.deepEqual(state(f, 'memos'), running);
  assert.deepEqual(state(f, 'wiki'), running);
  assert.equal(f.dashboard().get('wiki')?.ready, true);
  await f.assertNetworksMatchApps();
});

for (const variant of ['removed since the backup', 'installed and removed since the backup', 'unknown to this box (setup, another box)'] as const) {
  test(`after a core restore an app ${variant} is denied at one revision on both sides and installs again`, async t => {
    const f = await fixture(t);
    const memos = f.record('memos');
    await f.install(f.record('wiki'));
    if (variant !== 'installed and removed since the backup') await f.install(memos);
    const set = await f.backup();
    if (variant === 'installed and removed since the backup') await f.install(memos);
    await f.uninstall('memos');
    if (variant.startsWith('unknown')) await f.forgetCredential('memos');

    await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: [] });

    // The dashboard's table came back from the backup (an active credential, or none); the store did not move.
    const sides = await f.credentialSides('memos');
    assert.equal(sides.store?.status, 'revoked');
    assert.deepEqual(sides.dashboard, sides.store, 'both sides hold the same revoked record');
    const wiki = await f.credentialSides('wiki');
    assert.equal(wiki.store?.status, 'active');
    assert.deepEqual(wiki.dashboard, wiki.store, 'a kept app keeps its credential');
    assert.equal(f.dashboard().get('wiki')?.ready, true);

    await f.install(memos);
    assert.deepEqual(state(f, 'memos'), running);
    assert.equal(f.dashboard().get('memos')?.ready, true);
    assert.deepEqual((await f.credentialSides('memos')).dashboard, (await f.credentialSides('memos')).store);
    await f.assertNetworksMatchApps();
  });
}

test('an app left pending because the dashboard holds another revision can be removed and installed again', async t => {
  const f = await fixture(t);
  const memos = f.record('memos');
  await f.install(memos);
  const backedUp = structuredClone(f.dashboard().get('memos')!);
  await f.uninstall('memos');
  // What a core restore before 0.6.13 left: the backup's active row against the store's later revocation.
  f.dashboard().set('memos', backedUp);

  await assert.rejects(f.install(memos), /App service integration is pending; reconcile credentials/);
  assert.deepEqual(state(f, 'memos'), { container: 'Stopped', enabled: false, desired: 'stopped', credential: 'pending' });

  // The removal's revocation cannot follow the dashboard's revision step by step; it is published as a fence.
  await f.uninstall('memos');
  const sides = await f.credentialSides('memos');
  assert.equal(sides.store?.status, 'revoked');
  assert.deepEqual(sides.dashboard, sides.store);

  await f.install(memos);
  assert.deepEqual(state(f, 'memos'), running);
  assert.equal(f.dashboard().get('memos')?.ready, true);
});

const withSignIn = (f: Awaited<ReturnType<typeof fixture>>, appId: string) =>
  f.record(appId, { enableSSO: true, ssoClientId: `youeye-app-${appId}` });

test('a kept app keeps the YouEye ID client the box has now, not the one in the backup', async t => {
  const f = await fixture(t);
  for (const appId of ['audiobookshelf', 'memos', 'wiki']) await f.install(withSignIn(f, appId));
  await f.install(f.record('notes'));
  const set = await f.backup();
  // Since the backup the client of two apps was made again (an app-only restore does that): a new secret, in
  // YouEye ID and in the app.
  f.remakeSignInClient('memos');
  f.remakeSignInClient('audiobookshelf');
  const before = new Map(['audiobookshelf', 'memos'].map(appId => [appId, f.apps.get(appId)!.signInSecret]));

  await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['wiki'] });

  for (const appId of ['audiobookshelf', 'memos']) {
    assert.equal(f.apps.get(appId)!.signInSecret, before.get(appId), 'nothing changes inside a kept app');
    assert.equal(f.signInWorks(appId), true, `${appId}: YouEye ID holds the secret the app has`);
  }
  assert.equal(f.signInWorks('wiki'), true, 'a restored app gets a new client from its reinstall');
  assert.deepEqual(state(f, 'notes'), running, 'an app without sign-in is kept as before');

  // A second core restore, with nothing selected, changes nothing either.
  await f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: [] });
  for (const appId of ['audiobookshelf', 'memos', 'wiki']) assert.equal(f.signInWorks(appId), true, appId);
});

test('the rollback puts back the kept apps\' clients the failed restore had read, not the backup\'s it left', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'wiki']) await f.install(withSignIn(f, appId));
  const set = await f.backup();
  f.remakeSignInClient('memos');
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  // The identity database is replaced, then the next one fails: the box now holds the backup's client rows.
  f.fail.database.set('youeye_ui', 1);
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: [], progress }), /Failed to restore youeye_ui/);
  assert.equal(f.signInWorks('memos'), false);
  assert.deepEqual(progress.keptAppClients?.map(client => client.client_id).sort(), ['youeye-app-memos', 'youeye-app-wiki']);

  await f.fullRestore(f.rollbackRestoreConfig({ passphrase, appIds: [], progress }, preRestore)!);

  assert.equal(f.signInWorks('memos'), true);
  assert.equal(f.signInWorks('wiki'), true);
  assert.deepEqual(state(f, 'memos'), running);
});

test('an app-only restore goes on after an app that fails and names it at the end', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'notes', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));

  await assert.rejects(f.restoreApps({ backupPath: set.backupPath, passphrase, appIds: ['memos', 'notes', 'wiki', 'absent'] }),
    /^Error: Failed to restore memos: memos did not pass its post-restore health check; Failed to restore absent: No archive found for absent \(restored: notes, wiki\)$/);
  // The apps after the failing one went through their restore.
  assert.deepEqual(f.uninstalled, []);
  for (const appId of ['notes', 'wiki']) assert.deepEqual(state(f, appId), running, appId);

  f.fail.restoreApp.clear();
  await f.restoreApps({ backupPath: set.backupPath, passphrase, appIds: ['memos', 'notes'] });
  assert.deepEqual(state(f, 'memos'), running);
});

test('the watchdog does not start a core service that a restore or its rollback has stopped', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  const preRestore = await f.backup();
  const windows: string[] = [];
  // A watchdog tick while the restore replaces the core volumes: every core service is stopped, and none may be
  // started under the restore (Caddy started here ran on a data directory that was being replaced).
  f.hooks.replacingVolumes = async () => {
    for (const name of STOPPED_BY_RESTORE) {
      assert.equal(f.containers.get(name), 'Stopped');
      assert.equal(await f.startWatchdogContainer(name), false, `the watchdog started ${name} under the restore`);
      assert.equal(f.containers.get(name), 'Stopped');
    }
    windows.push('checked');
  };
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], progress }), /Failed to restore memos/);
  assert.equal(await f.rollBackRestore({ passphrase, appIds: ['memos'], progress }, preRestore), 'recovered');
  assert.deepEqual(windows, ['checked', 'checked'], 'the restore and its rollback each had the window');

  // Afterwards the watchdog has its services back: nothing is held.
  for (const name of STOPPED_BY_RESTORE) assert.equal(maintenance.isContainerHeldByOperation(name), false);
  f.containers.set('youeye-caddy', 'Stopped');
  assert.equal(await f.startWatchdogContainer('youeye-caddy'), true);
  assert.deepEqual(state(f, 'memos'), running);
});

test('holds on containers are counted, are released once each, and suppress the watchdog like a lease', () => {
  const outer = maintenance.holdContainersForOperation(['youeye-caddy', 'youeye-ui']);
  const inner = maintenance.holdContainersForOperation(['youeye-caddy']);
  assert.equal(maintenance.isContainerMaintenanceActive('youeye-caddy'), true);
  inner(); inner();
  assert.equal(maintenance.isContainerHeldByOperation('youeye-caddy'), true, 'the outer hold is still there');
  outer();
  assert.equal(maintenance.isContainerHeldByOperation('youeye-caddy'), false);
  assert.equal(maintenance.isContainerHeldByOperation('youeye-ui'), false);
  // The health monitor does not report a held service as down: that critical issue would refuse app installs.
  const monitor = readFileSync(path.join(import.meta.dirname, '../src/lib/health/monitor.ts'), 'utf8');
  assert.match(monitor, /if \(isContainerHeldByOperation\(`youeye-\$\{svc\.slug\}`\)\) continue;/);
});

test('a rollback that fails is run again and puts the box back', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'wiki']) await f.install(withSignIn(f, appId));
  const set = await f.backup();
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], progress }), /Failed to restore memos/);

  // The first rollback attempt stops with the core services down; the second starts them and finishes.
  f.fail.database.set('youeye_ui', 1);
  assert.equal(await f.rollBackRestore({ passphrase, appIds: ['memos'], progress }, preRestore), 'recovered');

  for (const name of CORE) assert.equal(f.containers.get(name), 'Running', name);
  assert.deepEqual([...f.apps.keys()].sort(), ['memos', 'wiki']);
  for (const appId of f.apps.keys()) {
    assert.deepEqual(state(f, appId), running, appId);
    assert.equal(f.signInWorks(appId), true, appId);
    assert.deepEqual((await f.credentialSides(appId)).dashboard, (await f.credentialSides(appId)).store);
  }
  await f.assertNetworksMatchApps();
});

test('when the rollback fails twice its own error is reported, and reconcile reopens a kept app', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  // Since that backup wiki's credential moved on, so the restore has to take the dashboard across a revision gap.
  const before = (await f.credentials.projection('wiki'))!.revision;
  await f.operations.operateAppCredential('wiki', { action: 'rotate', expectedRevision: before });
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], progress }), /Failed to restore memos/);

  // Like the live failure: the rollback gets past the databases and stops at Caddy's configuration, twice.
  f.fail.caddy = 2;
  await assert.rejects(f.rollBackRestore({ passphrase, appIds: ['memos'], progress }, preRestore),
    /^Error: Could not restore the server routing configuration: Error: Caddy refused the configuration$/);

  // The state the rollback left: the kept app installed, stopped and pending; the dashboard's row is the
  // pre-restore backup's, behind the credential store.
  assert.deepEqual(state(f, 'wiki'), { container: 'Stopped', enabled: false, desired: 'stopped', credential: 'pending' });
  const stale = await f.credentialSides('wiki');
  assert.ok(stale.dashboard!.revision < stale.store!.revision);
  for (const name of STOPPED_BY_RESTORE) assert.equal(maintenance.isContainerHeldByOperation(name), false);

  await f.operations.operateAppCredential('wiki', { action: 'reconcile' });

  assert.deepEqual(state(f, 'wiki'), running);
  const sides = await f.credentialSides('wiki');
  assert.equal(sides.store?.status, 'active');
  assert.deepEqual(sides.dashboard, sides.store);
  assert.equal(f.dashboard().get('wiki')?.ready, true);
});

test('a failed restore reports why it failed, also when a kept app cannot be stopped or the dashboard cannot be told', async t => {
  const f = await fixture(t);
  for (const appId of ['memos', 'wiki']) await f.install(f.record(appId));
  const set = await f.backup();
  f.fail.restoreApp.add(f.appArchive(set, 'memos'));
  // The dashboard stops answering when the app restore fails: the kept app is stopped all the same, and the
  // error is the restore's.
  f.hooks.appRestoreFailed = () => { f.fail.dashboard = true; };
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'] }),
    /^Error: Failed to restore memos: Error: memos did not pass its post-restore health check$/);
  assert.equal(state(f, 'wiki').container, 'Stopped');
  assert.equal(state(f, 'wiki').credential, 'pending');

  f.fail.dashboard = false;
  f.hooks.appRestoreFailed = () => { f.fail.quiesce.add('app-wiki'); };
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'] }),
    /^Error: Failed to restore memos: .*; kept apps that could not be stopped and need reconciliation: wiki$/);
});

test('a restore refused before it changes the box removes nothing and is not rolled back', async t => {
  const f = await fixture(t);
  await f.install(f.record('memos'));
  const set = await f.backup();
  // Installed after the backup: the core in the backup does not know it, so the restore cannot keep it.
  await f.install(f.record('wiki'));
  const preRestore = await f.backup();
  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };

  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], progress }),
    /Retained wiki requires a matching core identity or its app archive/);

  assert.equal(progress.changed, false);
  assert.equal(f.rollbackRestoreConfig({ passphrase, appIds: ['memos'], progress }, preRestore), null);
  // The route asks for the checks alone before it makes the pre-restore backup: the same refusal, and for a
  // restore that would run, no change.
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], checkOnly: true }),
    /Retained wiki requires a matching core identity or its app archive/);
  await f.fullRestore({ backupPath: preRestore.backupPath, passphrase, appIds: ['memos'], checkOnly: true, progress });
  assert.equal(progress.changed, false);
  assert.deepEqual(f.appliedVolumes, []);
  assert.deepEqual(f.uninstalled, []);
  assert.deepEqual(state(f, 'memos'), running);
  assert.deepEqual(state(f, 'wiki'), running);
  for (const name of CORE) assert.equal(f.containers.get(name), 'Running');

  // A selection is always explicit: there is no restore that replaces every app on a box in use.
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase } as FullRestoreConfig), /invalid app identifier/);
  await assert.rejects(f.fullRestore({ backupPath: set.backupPath, passphrase, appIds: ['memos'], discardAppIds: ['memos'] }),
    /both to restore and to remove/);
  assert.deepEqual(f.uninstalled, []);
});

test('the restore route rolls back through rollbackRestoreConfig and only after a change', () => {
  const route = readFileSync(path.join(import.meta.dirname, '../src/app/api/backup/restore/route.ts'), 'utf8');
  assert.match(route, /fullRestore\(\{ backupPath, passphrase, appIds, progress \}, relay\)/);
  // The refusing checks run before the pre-restore backup is made.
  const check = route.indexOf('fullRestore({ backupPath, passphrase, appIds, checkOnly: true }');
  assert.ok(check > 0 && check < route.indexOf("createPlatformBackup({ passphrase, reason: 'pre-restore' }"));
  assert.match(route, /rollBackRestore\(\s*\{ passphrase, appIds, progress \}, \{ backupPath: rollbackPath, apps: rollbackApps \}, logged\('rollback'\)\)/);
  // The watchdog is kept out of the core services across the restore and its rollback, on every way out.
  assert.ok(route.indexOf('holdRestoreServices()') > 0 && route.indexOf('holdRestoreServices()') < route.indexOf('checkOnly: true'));
  assert.match(route, /\} finally \{\s*releaseServices\(\);/);
  // The pre-restore backup is never restored as a whole-server restore (that removed every app before reinstalling).
  assert.doesNotMatch(route, /fullRestore\(\{ backupPath: rollbackPath/);
  assert.match(route, /Restore refused, nothing on the server was changed/);
  // Apps without the core: every selected app is tried (restoreApps), not only those before the first failure.
  assert.match(route, /await restoreApps\(\{ backupPath, passphrase, appIds \}, relay\)/);
  assert.doesNotMatch(route, /for \(const appId of appIds\)/);
});

test('every archive of a set is restored with the encryption the set records, and a set without a record with none', async t => {
  const f = await fixture(t);
  await f.install(f.record('memos'));
  const encryption = { cipher: 'aes-256-cbc', kdf: 'pbkdf2', digest: 'sha256', iterations: 20000, mac: 'hmac-sha256-pbkdf2' };
  const recorded = await f.backup({ encryption });
  await f.fullRestore({ backupPath: recorded.backupPath, passphrase, appIds: ['memos'] });
  assert.deepEqual(f.encryptions.map(item => item.encryption), [encryption, encryption], 'core and app archive');
  await f.restoreApps({ backupPath: recorded.backupPath, passphrase, appIds: ['memos'] });
  assert.deepEqual(f.encryptions.at(-1)?.encryption, encryption, 'an app restored on its own');

  // Made before the record (0.6.14): Spine is sent no parameters and uses those of that time.
  f.encryptions.length = 0;
  const older = await f.backup();
  await f.fullRestore({ backupPath: older.backupPath, passphrase, appIds: ['memos'] });
  assert.deepEqual(f.encryptions.map(item => item.encryption), [undefined, undefined]);

  // Recorded before the .hmac key was derived (a 0.6.15 build without `mac`): sent as recorded, and Spine checks the
  // .hmac file with the raw passphrase as before.
  f.encryptions.length = 0;
  const withoutMac = { cipher: 'aes-256-cbc', kdf: 'pbkdf2', digest: 'sha256', iterations: 10000 };
  const early = await f.backup({ encryption: withoutMac });
  await f.fullRestore({ backupPath: early.backupPath, passphrase, appIds: ['memos'] });
  assert.deepEqual(f.encryptions.map(item => item.encryption), [withoutMac, withoutMac]);

  const unreadable = await f.backup({ encryption: { cipher: 'aes-256-cbc' } });
  await assert.rejects(f.fullRestore({ backupPath: unreadable.backupPath, passphrase, appIds: ['memos'] }), /encryption in a form/);
  const badMac = await f.backup({ encryption: { ...withoutMac, mac: 7 } });
  await assert.rejects(f.fullRestore({ backupPath: badMac.backupPath, passphrase, appIds: ['memos'] }), /encryption in a form/);
});
