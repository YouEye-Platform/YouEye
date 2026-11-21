import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// A platform backup takes the lifecycle lock once per archive, so a System update can get its reservation between
// two archives. The next archive is then refused at once (by the Control Panel's own admission or by Spine's
// /api/backup/run). This is how the set ends: failed and deleted (nothing left "creating", no half set that counts
// as a recovery point, nothing sent to the drive), the operation lock released so Spine's Control Panel restart is
// not held, and the scheduled backup still due, tried again after the 30-minute pause.
const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const nodeRequire = createRequire(import.meta.url);

function load(file: string, mocks: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith('node:')) return nodeRequire(name);
    throw new Error(`Unexpected import: ${name}`);
  }, exports);
  return exports;
}

class SpineTransportError extends Error {}

const encryption = { cipher: 'aes-256-cbc', kdf: 'pbkdf2', digest: 'sha256', iterations: 10000, mac: 'hmac-sha256-pbkdf2' };
const REFUSAL = 'Failed to start backup: System update or recovery owns the platform lifecycle';

async function fixture(t: test.TestContext) {
  const backupRoot = await mkdtemp(path.join(tmpdir(), 'backup-set-refused-'));
  t.after(() => rm(backupRoot, { recursive: true, force: true }));
  const state = {
    updateReserved: false,
    reserveAfter: 'memos' as string | null,
    archives: [] as string[],
    setsDuringRefusal: null as string[] | null,
    locks: 0, releases: 0, stored: 0,
    saved: [] as Array<Record<string, any>>,
    config: {
      enabled: true, mediaId: 'drive-1', recoveryKeyStored: true, selectedApps: ['memos', 'photos'],
      schedule: { core: { frequency: 'daily', time: '03:00' }, defaultApp: { frequency: 'daily' }, overrides: {} },
    } as Record<string, any>,
  };
  const sets = path.join(backupRoot, 'sets');
  // An archive step, as backupCore and backupApp end when the platform is reserved: refused before anything is made.
  const archive = async (name: string) => {
    if (state.updateReserved) {
      state.setsDuringRefusal = await readdir(sets);
      throw new Error(REFUSAL);
    }
    state.archives.push(name);
    // The System update gets its reservation after the first app's archive, between two archives.
    if (name === state.reserveAfter) { state.updateReserved = true; state.reserveAfter = null; }
    return encryption;
  };
  const spineClient = {
    async storeBackupSet() { state.stored++; },
    async getBackupConfig() { return state.config; },
    async setBackupConfig(config: Record<string, any>) { state.saved.push(config); state.config = config; },
    async getBackupMedia() { return { media: [{ id: 'drive-1', state: 'ready' }] }; },
  };
  const backup = load('src/lib/backup/platform-backup.ts', {
    '@/lib/market/metadata': { listInstalledApps: async () => [{ appId: 'memos' }, { appId: 'photos' }] },
    './app-backup': { backupApp: async (config: { appId: string }) => archive(config.appId) },
    './core-backup': { backupCore: async () => archive('core') },
    '@/lib/spine/client': { spineClient, SpineAPIError: class extends Error {}, SpineTransportError },
    './workspace': { BACKUP_ROOT: backupRoot },
    './compatibility': { readCurrentBackupSourceIdentity: async () => ({ schema: 'youeye.backup.source.v1' }) },
    '@/lib/market/update-executor-lock': { AppUpdateExecutorLock: { acquire: () => { state.locks++; return { release() { state.releases++; } }; } } },
    '@/lib/market/update-admission': { isAppUpdateReserved: () => false },
  });
  const scheduler = load('src/lib/backup/scheduler.ts', {
    './platform-backup': backup,
    '@/lib/spine/client': { spineClient },
    '@/lib/health/notification-bridge': { sendNotificationToUI: async () => {} },
  });
  return { state, backup, scheduler, sets };
}

test('an archive refused for a System update fails the set cleanly: nothing left creating, no half set kept or stored', async t => {
  const f = await fixture(t);
  const events: Array<{ status: string }> = [];
  await assert.rejects(
    f.backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, (event: { status: string }) => events.push(event)),
    { message: REFUSAL },
  );
  assert.deepEqual(f.state.archives, ['core', 'memos'], 'the archives before the reservation were made; the refused one was not');
  assert.equal(f.state.setsDuringRefusal?.length, 1, 'the set existed while its archives were made');
  assert.deepEqual(await readdir(f.sets), [], 'the half set is deleted: no "creating" record and nothing that lists as a recovery point');
  assert.equal(f.state.stored, 0, 'a half set never reaches the backup drive');
  assert.equal(events.some(event => event.status === 'completed'), false);
  assert.deepEqual([f.state.locks, f.state.releases], [1, 1], 'the backup operation lock is released, so a Control Panel restart is not held');
});

test('a scheduled backup refused for a System update stays due and runs again after the pause', async t => {
  const f = await fixture(t);
  const due = new Date('2026-11-21T12:00:00Z');
  due.setHours(3, 5, 0, 0); // the schedule's time (03:00) is local
  let clock = due.getTime();
  t.mock.method(Date, 'now', () => clock);

  await f.scheduler.checkScheduledBackup(new Date(clock));
  assert.equal(f.state.saved.length, 1);
  assert.equal(f.state.saved[0].lastError, REFUSAL, 'the owner sees why the automatic backup did not run');
  assert.equal(f.state.saved[0].schedule.core.last_run, undefined, 'the failed set is not counted as a run');
  assert.deepEqual(f.state.saved[0].schedule.overrides, {}, 'no app is counted as backed up, the ones archived before the refusal included');
  assert.deepEqual(await readdir(f.sets), []);

  // Within the 30-minute pause nothing is tried.
  clock += 29 * 60 * 1000;
  await f.scheduler.checkScheduledBackup(new Date(clock));
  assert.equal(f.state.saved.length, 1);
  assert.deepEqual(f.state.archives, ['core', 'memos']);

  // After it, with the System update over, the same due backup runs whole and is recorded.
  f.state.updateReserved = false;
  f.state.archives.length = 0;
  clock += 2 * 60 * 1000;
  const retriedAt = new Date(clock);
  await f.scheduler.checkScheduledBackup(retriedAt);
  assert.deepEqual(f.state.archives, ['core', 'memos', 'photos']);
  assert.equal(f.state.stored, 1, 'the whole set went to the drive');
  assert.equal(f.state.saved.length, 2);
  assert.equal(f.state.saved[1].lastError, undefined);
  assert.equal(f.state.saved[1].schedule.core.last_run, retriedAt.toISOString());
  assert.deepEqual(Object.keys(f.state.saved[1].schedule.overrides).sort(), ['memos', 'photos']);
  assert.deepEqual(await readdir(f.sets), [], 'the stored set\'s local copy is gone');
});
