import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { AppUpdateExecutorLock } from '../src/lib/market/update-executor-lock';
import { withSetupMutation } from '../src/lib/setup/lifecycle';
import * as recovery from '../src/lib/setup/restore-recovery';
import type { FullRestoreConfig } from '../src/lib/backup/types';

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, '..');
const operationId = 'a1234567-1234-4234-8234-123456789abc';
const backupId = 'backup-20261029T120000Z-1234abcd';
const source = 'a'.repeat(64);
const body = { operationId, backupId, mediaId: 'drive', appIds: ['notes'], passphrase: 'fixture-recovery-key' };
const load = (filename: string, dependencies: Record<string, unknown>): Record<string, any> => {
  const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected dependency ${name}`);
  }, exports);
  return exports;
};

async function platformFixture(t: { after: (work: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'setup-restore-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const platform = load('src/lib/backup/platform-backup.ts', {
    '@/lib/market/metadata': {}, './app-backup': {}, './core-backup': {}, '@/lib/spine/client': {},
    './workspace': { BACKUP_ROOT: directory }, './compatibility': {},
    '@/lib/market/update-executor-lock': { AppUpdateExecutorLock },
  });
  return { directory, platform };
}

async function fixture(t: { after: (work: () => Promise<void>) => void }) {
  const f = await platformFixture(t);
  const state = {
    session: { isAdmin: true, setupOwnerId: 'owner', setupSessionId: 'session' } as {
      isAdmin: boolean; setupOwnerId: string; setupSessionId: string;
    } | null,
    csrf: true, machine: 'fixture-machine', setupCompleted: false,
    imports: 0, restores: 0, patches: 0, restarts: 0,
    restore: async (_config: FullRestoreConfig) => {},
    patch: async () => {}, restart: async () => {}, importBackup: async () => '/protected/input',
  };
  class SpineAPIError extends Error {}
  class BoundStore extends recovery.SetupRestoreStore {
    constructor() { super(path.join(f.directory, 'records')); }
  }
  const store = new BoundStore();
  const route = load('src/app/api/setup/restore/route.ts', {
    'next/server': { NextResponse: { json: (value: unknown, init?: ResponseInit) => Response.json(value, init) } },
    'node:fs/promises': { readFile: async () => state.machine },
    '@/lib/auth': { getSession: async () => state.session, verifyCSRFToken: async () => state.csrf },
    '@/lib/spine/client': {
      SpineAPIError,
      spineClient: {
        getConfig: async () => ({ setup_completed: state.setupCompleted }),
        patchConfig: async () => { state.patches++; state.setupCompleted = true; await state.patch(); },
        restartControl: async () => { state.restarts++; await state.restart(); },
        importBackupSet: async () => { state.imports++; return { backup_path: await state.importBackup() }; },
      },
    },
    '@/lib/setup/lifecycle': {
      withSetupMutation: (owner: string, kind: 'restore', id: string, work: (settle: () => void) => Promise<unknown>) =>
        withSetupMutation(owner, kind, id, work, {
          directory: path.join(f.directory, 'admission'), readiness: async () => {},
        }),
    },
    '@/lib/backup/full-restore': {
      fullRestore: async (config: FullRestoreConfig) => {
        state.restores++;
        await config.setupRecovery!.step('restore-app:notes', 'never', () => state.restore(config));
      },
    },
    '@/lib/backup/platform-backup': f.platform,
    '@/lib/setup/restore-recovery': { ...recovery, SetupRestoreStore: BoundStore },
    '@/lib/setup/restore-source': {
      importFreshSetupRestoreSource: async (options: { expectedSource?: string; importBackup(): Promise<string> }) => {
        if (options.expectedSource) assert.equal(options.expectedSource, source);
        return { backupPath: await options.importBackup(), source };
      },
    },
  });
  const post = (changes = {}) => route.POST(new Request('http://setup.test/api/setup/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' },
    body: JSON.stringify({ ...body, ...changes }),
  })) as Promise<Response>;
  const get = (id = operationId) => route.GET({
    nextUrl: new URL(`http://setup.test/api/setup/restore?operationId=${id}`),
  }) as Promise<Response>;
  return { ...f, state, store, route, post, get, SpineAPIError };
}

test('route status keeps owner, session and VM binding and returns only safe public fields', async t => {
  const f = await fixture(t);
  assert.match(await (await f.post()).text(), /"complete":true/);
  const response = await f.get();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    operationId, status: 'completed', phase: 'completed', active: false, recovery: 'none',
    mediaId: body.mediaId, backupId, appIds: body.appIds,
    messageCode: 'restore-completed', message: 'Restore complete. Sign in with a restored account.',
  });
  const original = f.state.session!;
  f.state.session = { ...original, setupOwnerId: 'foreign-owner' };
  assert.equal((await f.get()).status, 404);
  f.state.session = { ...original, setupSessionId: 'foreign-session' };
  assert.equal((await f.get()).status, 404);
  f.state.session = original;
  f.state.machine = 'foreign-machine';
  assert.equal((await f.get()).status, 404);
  f.state.session = null;
  assert.equal((await f.get()).status, 403);
  f.state.session = original;
  assert.equal((await f.get('invalid')).status, 400);
});

test('completed restore resumes after setup_completed without repeating import, restore, patch or restart', async t => {
  const f = await fixture(t);
  await (await f.post()).text();
  assert.equal(f.state.setupCompleted, true);
  const duplicate = await f.post();
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'resume-required');
  assert.match(await (await f.post({ action: 'resume' })).text(), /"complete":true/);
  assert.deepEqual([f.state.imports, f.state.restores, f.state.patches, f.state.restarts], [1, 1, 1, 1]);
  assert.equal((await f.post({ operationId: randomUUID() })).status, 403);
  assert.equal((await f.post({ action: 'resume', mediaId: 'foreign-drive' })).status, 409);
  assert.equal((await f.post({ action: 'resume', operationId: randomUUID() })).status, 409);
});

test('route retains unknown app effects, rejects resume deterministically and cannot start a different operation', async t => {
  const f = await fixture(t);
  f.state.restore = async () => { throw new Error('fixture database-password and private path'); };
  const stream = await (await f.post()).text();
  assert.match(stream, /"code":"restore-failed"/);
  assert.doesNotMatch(stream, /database-password|private path/);
  const status = await (await f.get()).json();
  assert.equal(status.recovery, 'operator-required');
  const resume = await f.post({ action: 'resume' });
  assert.equal(resume.status, 409);
  assert.equal((await resume.json()).code, 'operator-required');
  assert.match(await (await f.post({ operationId: randomUUID() })).text(), /"error":/);
  assert.equal(f.state.restores, 1);
  assert.equal(f.state.setupCompleted, false);
  assert.equal((await f.get()).status, 200);
});

test('acknowledged recovery-key rejection offers exact-operation resume', async t => {
  const f = await fixture(t);
  f.state.importBackup = async () => { throw new f.SpineAPIError('wrong password: fixture-secret'); };
  const failed = await (await f.post()).text();
  assert.match(failed, /"code":"import-failed"/);
  assert.doesNotMatch(failed, /fixture-secret|wrong password/);
  assert.equal((await (await f.get()).json()).recovery, 'resume');
  f.state.importBackup = async () => '/protected/input';
  assert.match(await (await f.post({ action: 'resume', passphrase: 'corrected-fixture-key' })).text(), /"complete":true/);
  assert.equal(f.state.imports, 2);
  assert.equal(f.state.restores, 1);
});

test('route finalization retry reads completion and never restores twice after a lost patch reply', async t => {
  const f = await fixture(t);
  f.state.patch = async () => { throw new Error('completion reply lost'); };
  assert.match(await (await f.post()).text(), /"error":/);
  assert.equal((await (await f.get()).json()).recovery, 'finalize');
  assert.match(await (await f.post({ action: 'resume' })).text(), /"complete":true/);
  assert.deepEqual([f.state.imports, f.state.restores, f.state.patches, f.state.restarts], [1, 1, 1, 1]);
});

test('GET observes active execution and POST resume cannot race its unfinished effect', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.state.restore = async () => { entered(); await gate; };
  const stream = await f.post();
  try {
    await waiting;
    const status = await (await f.get()).json();
    assert.equal(status.active, true);
    assert.equal(status.status, 'running');
    assert.equal(status.recovery, 'none');
    const conflict = await f.post({ action: 'resume' });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'operation-active');
    assert.equal(f.state.restores, 1);
  } finally { release(); }
  assert.match(await stream.text(), /"complete":true/);
});

test('bad CSRF, invalid actions and damaged retained state cannot authorize restore', async t => {
  const f = await fixture(t);
  f.state.csrf = false;
  assert.equal((await f.post()).status, 403);
  f.state.csrf = true;
  assert.equal((await f.post({ action: 'reconcile' })).status, 400);
  assert.equal((await f.post({ appIds: ['notes', 'notes'] })).status, 400);
  assert.equal((await f.post({ operationId: '../foreign' })).status, 400);
  assert.equal(f.state.imports, 0);
  await (await f.post()).text();
  await writeFile(path.join(f.store.directory, `${operationId}.json`), '{');
  assert.equal((await f.get()).status, 503);
  assert.equal((await f.post({ action: 'resume' })).status, 503);
  assert.equal(f.state.restores, 1);
});

test('backup lease holds across awaits, releases on failure and never expires a retained legacy lock', async t => {
  const f = await platformFixture(t);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = f.platform.withRestoreLock(async () => { entered(); await gate; });
  await waiting;
  try { await assert.rejects(f.platform.withRestoreLock(async () => {}), /busy/); }
  finally { release(); }
  await running;
  await assert.rejects(f.platform.withRestoreLock(async () => { throw new Error('interrupted'); }), /interrupted/);
  await f.platform.withRestoreLock(async () => {});
  const legacy = path.join(f.directory, '.operation.lock');
  const retained = JSON.stringify({ operation: 'restore', startedAt: '2000-01-01T00:00:00Z', pid: 0 });
  await writeFile(legacy, retained, { mode: 0o600 });
  await assert.rejects(f.platform.withRestoreLock(async () => { assert.fail('legacy lock was stolen'); }), /operator reconciliation/);
  assert.equal(await readFile(legacy, 'utf8'), retained);
});

test('legacy status is inspectable but cannot authorize replay, and damaged legacy status is unavailable', async t => {
  const f = await fixture(t);
  const directory = path.join(f.directory, '.restore-status');
  await mkdir(directory, { mode: 0o700 });
  const filename = path.join(directory, `${operationId}.json`);
  await writeFile(filename, JSON.stringify({
    schema: 'youeye.backup.restore-status.v1', operationId, backupId,
    status: 'completed', message: 'raw legacy fixture details', setupSessionId: 'session',
  }), { mode: 0o600 });
  const status = await (await f.get()).json();
  assert.equal(status.status, 'failed');
  assert.equal(status.phase, 'legacy');
  assert.equal(status.recovery, 'operator-required');
  assert.doesNotMatch(JSON.stringify(status), /raw legacy/);
  assert.equal((await f.post()).status, 409);
  const legacyResume = await f.post({ action: 'resume' });
  assert.equal(legacyResume.status, 409);
  assert.equal((await legacyResume.json()).code, 'operator-required');
  await writeFile(filename, '{');
  assert.equal((await f.get()).status, 503);
  assert.equal((await f.post()).status, 503);
  assert.equal(await f.platform.readRestoreStatus(operationId), null);
  await rm(filename);
  await symlink(path.join(f.directory, 'absent'), filename);
  // O_NOFOLLOW must distinguish a broken symlink from a missing receipt.
  assert.equal((await f.get()).status, 503);
  assert.equal(f.state.imports, 0);
});
