import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import {
  runSetupRestore, SetupRestoreError, SetupRestoreStore, setupRestoreTargetIdentity, type SetupRestoreRecord,
} from '../src/lib/setup/restore-recovery';
import type { SetupRestoreCheckpoint } from '../src/lib/backup/types';

const require = createRequire(import.meta.url);
const databases = ['youeye', 'youeye_ui', 'pointer'];

async function fixture(t: { after: (work: () => Promise<void>) => void }, machineReadError?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'setup-restore-full-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backupPath = path.join(directory, 'input');
  await mkdir(path.join(backupPath, 'youeye/core'), { recursive: true });
  await mkdir(path.join(backupPath, 'youeye/apps/notes'), { recursive: true });
  await writeFile(path.join(backupPath, 'youeye/core/core-fixture.tar.enc'), 'encrypted-fixture');
  await writeFile(path.join(backupPath, 'youeye/apps/notes/notes-fixture.tar.enc'), 'encrypted-fixture');
  const state = { inventoryReads: 0, databaseCalls: 0, volumeCalls: 0, machineRemovals: 0 };
  const forbidden = async () => { assert.fail('completed live restore effect replayed'); };
  const dependencies: Record<string, any> = {
    '@/lib/spine/client': {
      spineClient: {
        restoreArchive: async ({ staging_dir: staging }: { staging_dir: string }) => {
          const files = {
            'backup-meta.json': JSON.stringify({
              schema: 'youeye.backup.core-meta.v1', type: 'core', admissionSchemaVersion: 1, databases, source: {},
            }),
            'configs/youeye-config.json': JSON.stringify({ domain: 'example.test' }),
            'caddy/caddy-config.json': '{}', 'pihole/pihole.toml': 'fixture', 'installed-apps.json': '[]',
            ...Object.fromEntries(databases.map(database => [`databases/${database}-2026-10-29.sql`, 'fixture-sql'])),
          };
          for (const [name, content] of Object.entries(files)) {
            await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
            await writeFile(path.join(staging, name), content);
          }
        },
        setConfig: forbidden, applyBackupVolumes: async () => { state.volumeCalls++; await forbidden(); },
      },
    },
    '@/lib/incus/server': { execCommand: forbidden, incusRequest: forbidden, incusUploadFile: forbidden },
    '@/lib/caddy/client': { setConfig: forbidden, ensureIdentityRoute: forbidden },
    '@/lib/market/update-admission': {
      withAppInventory: (work: () => Promise<void>) => work(),
      withAppLifecycles: (_ids: string[], work: () => Promise<void>) => work(),
    },
    './app-restore': { restoreApp: forbidden },
    '@/lib/market/metadata': {
      listInstalledApps: async () => {
        state.inventoryReads++;
        assert.equal(state.inventoryReads, 1, 'restored inventory must not become new removal authority');
        return [];
      },
      listRetainedApps: forbidden, saveInstallMetadata: forbidden,
    },
    '@/lib/market/uninstaller': { uninstallApp: forbidden, deregisterAppFromUI: forbidden },
    '@/lib/admission/store': {}, '@/lib/identity/store': {}, '@/lib/market/installed-apps': {},
    '../../../../shared/admission': { isUuid: () => true },
    '@/lib/apps/service-credential-probe': { quiesceAppCredentialRuntime: async () => {} },
    '@/lib/identity/provider': {}, './workspace': { BACKUP_STAGING_ROOT: path.join(directory, 'staging') },
    './postgres': {
      PLATFORM_DATABASES: databases, isPlatformDatabase: (name: string) => databases.includes(name),
      replacePlatformDatabase: async () => { state.databaseCalls++; throw new Error('SQL reply lost'); },
    },
    './compatibility': {
      readCurrentBackupSourceIdentity: async () => ({}), assessBackupCompatibility: () => ({ compatible: true }),
    },
    '@/lib/apps/pihole-api': {},
    '@/lib/identity/config': {
      getIdentityConfig: async () => ({ issuer: 'https://id.example.test', containerName: 'youeye-identity', port: 8080 }),
    },
    '@/lib/identity/core-clients': {}, '@/lib/acme/storage': {}, '@/lib/infrastructure/deployer': {},
    './retained-apps': { readRetainedAppInventory: async () => [], restoreRetainedApps: forbidden },
    '@/lib/apps/service-credential-bridge': {}, '@/lib/apps/service-credential-operations': {},
    '@/lib/maintenance/container-maintenance': {}, '@/lib/apps/service-credential-store': {},
  };
  const filename = path.join(import.meta.dirname, '../src/lib/backup/full-restore.ts');
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name === 'fs/promises') {
      const fs = require(name);
      return {
        ...fs,
        readFile: (filename: string, ...args: unknown[]) => {
          if (filename === '/var/lib/youeye/config/cli-token' || filename === '/var/lib/youeye/config/config.yaml') {
            if (machineReadError) throw Object.assign(new Error('fixture read failure'), { code: machineReadError });
            return Promise.resolve(Buffer.from('fixture-machine-config'));
          }
          return fs.readFile(filename, ...args);
        },
        rm: (filename: string, ...args: unknown[]) => {
          if (filename.startsWith('/var/lib/youeye/config/')) {
            state.machineRemovals++;
            assert.fail('machine configuration must not be removed after failed capture');
          }
          return fs.rm(filename, ...args);
        },
      };
    }
    if (name.startsWith('node:') || ['fs', 'fs/promises', 'path'].includes(name)) return require(name);
    throw new Error(`Unexpected dependency ${name}`);
  }, exports);
  return { directory, backupPath, state, fullRestore: exports.fullRestore };
}

test('real fullRestore skips completed mutation gates and does not reinterpret restored inventory', async t => {
  const f = await fixture(t);
  const checkpoint: SetupRestoreCheckpoint = {
    completed: () => true, step: async () => {},
    rememberQuiesced: async () => { assert.fail('completed volume quiescence replayed'); }, quiesced: () => [],
  };
  const events: { status: string }[] = [];
  await f.fullRestore({ backupPath: f.backupPath, passphrase: 'fixture-key', appIds: ['notes'], setupMode: true,
    setupRecovery: checkpoint }, (event: { status: string }) => events.push(event));
  assert.equal(f.state.inventoryReads, 1);
  assert.equal(f.state.databaseCalls, 0);
  assert.equal(events.at(-1)!.status, 'completed');
});

for (const code of ['EACCES', 'EIO', 'ENOENT']) {
  test(`machine credential ${code} stops setup restore before volume application or configuration deletion`, async t => {
    const f = await fixture(t, code);
    const checkpoint: SetupRestoreCheckpoint = {
      completed: name => name !== 'restore-volumes',
      step: async (name, _retry, work) => { if (name === 'restore-volumes') await work(); },
      rememberQuiesced: async () => { assert.fail('failed capture must not quiesce services'); },
      quiesced: () => [],
    };
    await assert.rejects(f.fullRestore({
      backupPath: f.backupPath, passphrase: 'fixture-key', appIds: ['notes'], setupMode: true, setupRecovery: checkpoint,
    }, () => {}), /could not be captured before restore/);
    assert.equal(f.state.volumeCalls, 0);
    assert.equal(f.state.machineRemovals, 0);
    assert.equal(f.state.databaseCalls, 0);
  });
}

test('a lost SQL execution reply in real fullRestore requires an operator before any retry', async t => {
  const f = await fixture(t);
  const store = new SetupRestoreStore(path.join(f.directory, 'records'));
  const identity = {
    operationId: randomUUID(), ownerId: 'owner', sessionId: 'session', mediaId: 'drive',
    backupId: 'backup-20261029T120000Z-1234abcd', appIds: ['notes'],
    target: setupRestoreTargetIdentity('fixture-machine'),
  };
  const now = new Date().toISOString();
  const record: SetupRestoreRecord = {
    schema: 'youeye.setup-restore/1', identity, source: 'a'.repeat(64),
    phase: 'restoring', status: 'failed', quiesced: [], restart: 'pending', startedAt: now, updatedAt: now,
    steps: Object.fromEntries(['source-import', 'remove-current-apps', 'restore-volumes', 'restore-config']
      .map(name => [name, { state: 'completed' as const, retry: name === 'restore-config' ? 'replace' as const : 'never' as const }])),
  };
  await store.write(record);
  let imports = 0, settled = false;
  const io = {
    store, importSource: async () => { imports++; return record.source!; },
    restore: (checkpoint: SetupRestoreCheckpoint) => f.fullRestore({
      backupPath: f.backupPath, passphrase: 'fixture-key', appIds: ['notes'], setupMode: true, setupRecovery: checkpoint,
    }, () => {}),
    setupCompleted: async () => false,
    completeSetup: async () => { assert.fail('failed SQL restore finalized'); },
    restartControl: async () => { assert.fail('failed SQL restore restarted Control Panel'); },
    settle: () => { settled = true; },
  };
  await assert.rejects(runSetupRestore(identity, 'resume', io),
    (error: unknown) => error instanceof SetupRestoreError && error.code === 'restore-failed');
  assert.equal(f.state.databaseCalls, 1);
  assert.equal((await store.readStatus(identity.operationId))!.status.recovery, 'operator-required');
  await assert.rejects(runSetupRestore(identity, 'resume', io),
    (error: unknown) => error instanceof SetupRestoreError && error.code === 'operator-required');
  assert.equal(f.state.databaseCalls, 1);
  assert.equal(imports, 1);
  assert.equal(settled, false);
});
