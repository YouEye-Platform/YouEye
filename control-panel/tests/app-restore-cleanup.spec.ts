import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import ts from 'typescript';

function loadModule(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(process.cwd(), 'src/lib', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, ...globals, require(name: string) {
    if (name in mocks) return mocks[name];
    if (name.startsWith('node:') || ['path', 'crypto'].includes(name)) return require(name);
    return new Proxy({}, { get: (_target, property) => {
      if (property === '__esModule') return true;
      return () => { throw Error(`Unexpected effect: ${name}.${String(property)}`); };
    } });
  } });
  return exports;
}
const binding = { appId: 'canvas-test', name: 'app-canvas-test',
  installationId: '20000000-0000-4000-8000-000000000001',
  ownerId: '10000000-0000-4000-8000-000000000001' };
function runtime(response: unknown) {
  let reads = 0;
  const module = loadModule('admission/runtime-ownership.ts', {
    '@/lib/incus/server': { incusRequest: async () => { reads++; return response; } },
    '../../../../shared/admission': { isUuid: (s: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s) },
  });
  return { verify: module.verifyRuntimeOwnership, reads: () => reads };
}
test('restore replacement accepts positive absence, while ordinary cleanup refuses it', async () => {
  const f = runtime({ type: 'error', error_code: 404 });
  await assert.rejects(f.verify(binding), /missing or mismatched/);
  await f.verify(binding, true);
  assert.equal(f.reads(), 2);
});
test('restore replacement rejects unavailable, mismatched and foreign runtime identity', async () => {
  for (const response of [
    { type: 'error', error_code: 503 },
    { type: 'sync', metadata: { name: 'foreign', config: {} } },
    { type: 'sync', metadata: { name: binding.name, config: {} } },
    { type: 'sync', metadata: { name: binding.name, config: {
      'user.youeye.app_id': binding.appId, 'user.youeye.installation_id': binding.installationId,
      'user.youeye.data_owner_id': '10000000-0000-4000-8000-000000000002',
    } } },
  ]) await assert.rejects(runtime(response).verify(binding, true));
  const f = runtime({ type: 'error', error_code: 404 });
  await assert.rejects(f.verify({ ...binding, ownerId: 'invalid' }, true), /Invalid runtime ownership/);
  assert.equal(f.reads(), 0);
});
test('existing exact-owned runtime still verifies during restore replacement', async () => {
  await runtime({ type: 'sync', metadata: { name: binding.name, config: {
    'user.youeye.app_id': binding.appId, 'user.youeye.installation_id': binding.installationId,
    'user.youeye.data_owner_id': binding.ownerId,
  } } }).verify(binding, true);
});

for (const databaseMode of ['none', 'own', 'shared']) test(`restore teardown respects ${databaseMode} database ownership`, async () => {
  let metadata: any = { appId: binding.appId, containers: [], databaseMode,
    ...(databaseMode === 'shared' ? { databaseName: 'fixture_db', databaseUser: 'fixture_role' } : {}) };
  let lease: unknown = {};
  const sql: string[][] = [];
  const pass = async (_id: unknown, action: () => unknown) => action();
  const module = loadModule('market/uninstaller.ts', {
    '../incus/server': { execCommand: async (_container: string, args: string[]) => {
      sql.push(args); return { exitCode: 0, stdout: '' }; } },
    '../infrastructure/oci-deployer': { containerExists: async () => false },
    '../caddy/client': { getRoutes: async () => [] },
    './metadata': { readInstallMetadata: async () => metadata, saveInstallMetadata: async () => {},
      removeInstallMetadata: async () => { metadata = null; } },
    './installed-apps': { removeInstalledApp: async () => {}, getInstalledApp: async () => null },
    './reconciler': { isAppRegisteredWithUI: async () => false },
    '../incus/app-network': { withAppNetworkOperationLock: async (_id: string, _op: string, fn: () => unknown) => fn(),
      removeSystemProxyDevices: async () => {}, removeCaddyFromAppNetwork: async () => {},
      deleteAppNetwork: async () => { lease = null; }, getAppNetworkLease: async () => lease },
    './storage': { deleteAppStorage: async () => {}, verifyAppStorageRemoval: async () => true },
    './update-admission': { withAppInventory: async (fn: () => unknown) => fn(), withAppLifecycle: pass },
    '../apps/service-credential-bridge': { revokeAppCredential: async () => {} },
    '@/lib/admission/lifecycle': { verifyAdmissionCleanup: async (_meta: unknown, keep: boolean, restore: boolean) => {
      assert.equal(keep, false); assert.equal(restore, true); } },
    '../bridges/manager': { getBridgesForApp: async () => [] },
    '../incus/container-ip': { getContainerIP: async () => '192.0.2.1' },
    fs: { readFileSync: () => { throw Error('No fixture token file'); } },
  }, { process: { env: { UI_BRIDGE_TOKEN: 'fixture-only' } }, fetch: async () => ({ ok: true, status: 200 }) });
  const result = await module.uninstallApp(binding.appId, { keepData: false,
    dropSharedDatabase: true, preserveAdmission: true });
  assert.equal(result.success, true);
  assert.equal(result.verification.databaseDropped, databaseMode === 'shared' ? true : null);
  assert.equal(sql.length, databaseMode === 'shared' ? 4 : 0);
  if (databaseMode === 'shared') assert.ok(sql.some(args => args.includes('DROP DATABASE IF EXISTS "fixture_db"')));
});

for (const currentMode of ['none', 'own', 'shared']) test(`historical restore removes only current ${currentMode} database resources`, async () => {
  const seen: boolean[] = [];
  const module = loadModule('backup/app-restore.ts', {
    'fs/promises': { mkdir: async () => {}, rm: async () => {}, readFile: async (file: string) => {
      if (file.endsWith('backup-meta.json')) return JSON.stringify({ schema: 'youeye.backup.app-meta.v1', appId: binding.appId });
      if (file.endsWith('install.json')) return JSON.stringify({ appId: binding.appId });
      if (file.endsWith('admission.json')) return '{}';
      if (file.endsWith('manifest.json')) return JSON.stringify({ database: { mode: currentMode === 'shared' ? 'none' : 'shared' } });
      throw Error('Unexpected file');
    } },
    fs: { existsSync: (file: string) => !file.endsWith('.sql') },
    '@/lib/spine/client': { spineClient: { restoreArchive: async () => {} } },
    '@/lib/market/metadata': { readInstallMetadata: async () => ({ appId: binding.appId, databaseMode: currentMode }) },
    '@/lib/market/uninstaller': { uninstallApp: async (_app: string, options: { dropSharedDatabase: boolean }) => {
      seen.push(options.dropSharedDatabase); throw Error('Fixture stops before destructive effects');
    } },
    './workspace': { BACKUP_STAGING_ROOT: '/fixture-only' },
    './compatibility': { readCurrentBackupSourceIdentity: async () => ({}), assessBackupCompatibility: () => ({ compatible: true }) },
    '@/lib/market/update-admission': { withAppInventory: async (fn: () => unknown) => fn(),
      withAppLifecycle: async (_id: string, fn: () => unknown) => fn() },
    './app-restore-intent': { readAppRestoreIntent: () => ({}) },
    '@/lib/admission/store': { getAdmissionPolicy: async () => ({}) },
    '@/lib/market/restored-managed-ai': { readRestoredManagedAI: () => undefined },
    '@/lib/admission/backup': { validateAppAdmissionRestore: async () => ({ policy: {} }) },
  });
  await assert.rejects(module.restoreApp({ appId: binding.appId, archivePath: '/fixture-only.tar.enc', passphrase: 'fixture-only' }, () => {}, false), /Fixture stops/);
  assert.deepEqual(seen, [currentMode === 'shared']);
});
