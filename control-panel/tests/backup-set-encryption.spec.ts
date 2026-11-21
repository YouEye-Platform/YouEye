import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadPlatformBackup(mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const source = readFileSync(path.join(process.cwd(), 'src/lib/backup/platform-backup.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, process, Buffer, require(name: string) {
    if (name in mocks) return mocks[name];
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected import: ${name}`);
  } });
  return exports;
}

class SpineTransportError extends Error {}

const encryption = { cipher: 'aes-256-cbc', kdf: 'pbkdf2', digest: 'sha256', iterations: 10000, mac: 'hmac-sha256-pbkdf2' };

async function fixture(t: test.TestContext, appEncryption: unknown, spineClient: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'backup-set-encryption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = loadPlatformBackup({
    '@/lib/market/metadata': { listInstalledApps: async () => [{ appId: 'memos' }] },
    './app-backup': { backupApp: async () => appEncryption },
    './core-backup': { backupCore: async () => encryption },
    '@/lib/spine/client': { spineClient, SpineAPIError: class extends Error {}, SpineTransportError },
    './workspace': { BACKUP_ROOT: root },
    './compatibility': { readCurrentBackupSourceIdentity: async () => ({ schema: 'youeye.backup.source.v1' }) },
    '@/lib/market/update-executor-lock': { AppUpdateExecutorLock: { acquire: () => ({ release() {} }) } },
    '@/lib/market/update-admission': { isAppUpdateReserved: () => false },
  });
  return { backup, root };
}

// The set records how Spine encrypted its archives, so a restore can send the parameters back (Plan 17 B5).
test('a backup set records the encryption Spine reports for its archives', async t => {
  const { backup, root } = await fixture(t, encryption);
  const record = await backup.createPlatformBackup({ passphrase: 'a recovery key of length' }, () => {});
  assert.deepEqual(record.encryption, encryption);
  const [id] = await readdir(path.join(root, 'sets'));
  const written = JSON.parse(await readFile(path.join(root, 'sets', id, 'backup-set.json'), 'utf8'));
  assert.equal(written.status, 'completed');
  assert.deepEqual(written.encryption, encryption);
});

test('a set whose archives were encrypted differently is not kept', async t => {
  const { backup, root } = await fixture(t, { ...encryption, iterations: 20000 });
  await assert.rejects(backup.createPlatformBackup({ passphrase: 'a recovery key of length' }, () => {}),
    /changed the backup encryption/);
  assert.deepEqual(await readdir(path.join(root, 'sets')), [], 'the failed set is deleted');
});

test('a set whose archives were authenticated differently is not kept', async t => {
  const { backup, root } = await fixture(t, { ...encryption, mac: undefined });
  await assert.rejects(backup.createPlatformBackup({ passphrase: 'a recovery key of length' }, () => {}),
    /changed the backup encryption/);
  assert.deepEqual(await readdir(path.join(root, 'sets')), [], 'the failed set is deleted');
});

// A set a killed backup left "creating" is deleted by the next backup (under the operation lock no other runs);
// completed sets stay.
test('the next backup deletes a set an earlier one left creating', async t => {
  const { backup, root } = await fixture(t, encryption);
  const sets = path.join(root, 'sets');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const abandoned = 'backup-20261121T010203Z-0000aaaa';
  const kept = 'backup-20261121T010204Z-0000bbbb';
  for (const [id, status] of [[abandoned, 'creating'], [kept, 'completed']]) {
    await mkdir(path.join(sets, id), { recursive: true });
    await writeFile(path.join(sets, id, 'backup-set.json'), JSON.stringify({ schema: 'youeye.backup.set.v1', id, status }));
  }
  const record = await backup.createPlatformBackup({ passphrase: 'a recovery key of length' }, () => {});
  assert.deepEqual((await readdir(sets)).sort(), [kept, record.id].sort());
});

// A set stored to the drive is "completed" before restic reads it; `<id>.storing` beside it until its local copy
// is gone tells a store a killed Control Panel never finished from a real local recovery point. Such a set is the
// only complete copy of its backup: it goes when the next set is safe, never before (until 0.6.15 the next backup
// deleted it first, and a backup that then failed left no complete copy).
test('a set whose store to the drive never finished goes only once the next set is stored', async t => {
  const seen: string[][] = [];
  let sets = '';
  let fail = true;
  const { backup, root } = await fixture(t, encryption, {
    async storeBackupSet() {
      seen.push(await readdir(sets));
      if (fail) throw new Error('the drive is not attached');
    },
  });
  sets = path.join(root, 'sets');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const older = 'backup-20261121T010201Z-00009999';
  const killed = 'backup-20261121T010203Z-0000aaaa';
  const local = 'backup-20261121T010204Z-0000bbbb';
  for (const id of [older, killed, local]) {
    await mkdir(path.join(sets, id), { recursive: true });
    await writeFile(path.join(sets, id, 'backup-set.json'), JSON.stringify({ schema: 'youeye.backup.set.v1', id, status: 'completed' }));
  }
  await writeFile(path.join(sets, `${older}.storing`), '');
  await writeFile(path.join(sets, `${killed}.storing`), '');

  // The next backup fails at the drive: the newest unfinished store is still there, complete.
  await assert.rejects(backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {}), /not attached/);
  assert.ok(seen[0].includes(killed) && seen[0].includes(`${killed}.storing`), 'the unfinished store is kept while the new set is written and stored');
  assert.ok(!seen[0].includes(older) && !seen[0].includes(`${older}.storing`), 'an older unfinished store is superseded by the newer one and goes at once');
  assert.deepEqual((await readdir(sets)).sort(), [killed, `${killed}.storing`, local].sort(), 'the failed backup deleted only itself');

  // The one after it succeeds: now the unfinished store goes, and the local recovery point stays.
  fail = false;
  const record = await backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {});
  assert.equal(seen.length, 2, 'the set was stored');
  assert.ok(seen[1].includes(`${record.id}.storing`), 'the set is marked while it is stored');
  assert.ok(seen[1].includes(killed), 'the unfinished store is still there while the new one is stored');
  assert.deepEqual(await readdir(sets), [local], 'both stored sets\' local copies and markers are gone; the local recovery point stays');
});

// Spine can restart under a store (a System update is admitted then: the store holds only the backup operation
// lock). The socket closes without an answer: Spine did not refuse the set, and the set is complete and the only
// copy. It is kept as a set left "storing" (until 0.6.15 it was marked failed and deleted), and goes once the next
// set is stored. A store Spine refuses still deletes the set (the test above).
test('a set whose store lost Spine is kept until the next set is stored', async t => {
  let lost = true;
  const { backup, root } = await fixture(t, encryption, {
    async storeBackupSet() {
      if (lost) throw new SpineTransportError('Spine API transport error: socket hang up');
    },
  });
  const sets = path.join(root, 'sets');
  await assert.rejects(backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {}), /socket hang up/);
  const left = (await readdir(sets)).sort();
  assert.equal(left.length, 2, 'the set and its marker are kept');
  const [id] = left;
  assert.deepEqual(left, [id, `${id}.storing`]);
  const written = JSON.parse(await readFile(path.join(sets, id, 'backup-set.json'), 'utf8'));
  assert.equal(written.status, 'completed', 'the kept set is still a complete set, not a failed one');
  assert.deepEqual(written.apps, ['memos']);

  lost = false;
  await new Promise(resolve => setTimeout(resolve, 1100)); // a set's ID starts with its second
  const next = await backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {});
  assert.notEqual(next.id, id);
  assert.deepEqual(await readdir(sets), [], 'the next stored set supersedes the kept one; both local copies are gone');
});

// The two other ways a store ends without Spine's answer, with the real client's errors: Spine's socket is not
// there at that moment (it is restarting), and Spine does not answer within the step's limit. Until 0.6.15 both
// were plain Errors, and the set, the only copy, was deleted.
test('a set whose store found no Spine socket, or got no answer in time, is kept', async t => {
  const http = await import('node:http');
  const client = await import('../src/lib/spine/client');
  const sockets = await mkdtemp(path.join(tmpdir(), 'backup-set-spine-'));
  const silent = http.createServer(() => { /* never answers */ });
  await new Promise<void>((resolve, reject) => { silent.once('error', reject); silent.listen(path.join(sockets, 'silent.sock'), resolve); });
  t.after(async () => {
    silent.closeAllConnections();
    await new Promise<void>(resolve => silent.close(() => resolve()));
    await rm(sockets, { recursive: true, force: true });
  });
  const original = http.ClientRequest.prototype.setTimeout;
  t.mock.method(http.ClientRequest.prototype, 'setTimeout', function (this: InstanceType<typeof http.ClientRequest>, _ms: number, callback?: () => void) {
    return original.call(this, 50, callback);
  });

  for (const [socket, message] of [['missing.sock', /could not reach the Spine API/], ['silent.sock', /Request timeout/]] as const) {
    const root = await mkdtemp(path.join(tmpdir(), 'backup-set-kept-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const spine = new client.SpineClient(path.join(sockets, socket));
    const backup = loadPlatformBackup({
      '@/lib/market/metadata': { listInstalledApps: async () => [{ appId: 'memos' }] },
      './app-backup': { backupApp: async () => encryption },
      './core-backup': { backupCore: async () => encryption },
      '@/lib/spine/client': {
        spineClient: { storeBackupSet: (request: never) => spine.storeBackupSet(request) },
        SpineAPIError: client.SpineAPIError, SpineTransportError: client.SpineTransportError,
      },
      './workspace': { BACKUP_ROOT: root },
      './compatibility': { readCurrentBackupSourceIdentity: async () => ({ schema: 'youeye.backup.source.v1' }) },
      '@/lib/market/update-executor-lock': { AppUpdateExecutorLock: { acquire: () => ({ release() {} }) } },
      '@/lib/market/update-admission': { isAppUpdateReserved: () => false },
    });
    await assert.rejects(backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {}), message);
    const left = (await readdir(path.join(root, 'sets'))).sort();
    assert.equal(left.length, 2, `${socket}: the set and its marker are kept`);
    assert.deepEqual(left, [left[0], `${left[0]}.storing`]);
    const written = JSON.parse(await readFile(path.join(root, 'sets', left[0], 'backup-set.json'), 'utf8'));
    assert.equal(written.status, 'completed', `${socket}: the kept set is still a complete set`);
  }
});

// A backup made without a drive supersedes an unfinished store too, once it is complete on the box.
test('a completed local set supersedes a set whose store never finished', async t => {
  const { backup, root } = await fixture(t, encryption);
  const sets = path.join(root, 'sets');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const killed = 'backup-20261121T010203Z-0000aaaa';
  await mkdir(path.join(sets, killed), { recursive: true });
  await writeFile(path.join(sets, killed, 'backup-set.json'), JSON.stringify({ schema: 'youeye.backup.set.v1', id: killed, status: 'completed' }));
  await writeFile(path.join(sets, `${killed}.storing`), '');
  const record = await backup.createPlatformBackup({ passphrase: 'a recovery key of length' }, () => {});
  assert.deepEqual(await readdir(sets), [record.id]);
});

// A new set supersedes a kept one only when it holds the kept set's apps. Until 0.6.15 any successful set did: a
// scheduled backup of the one app that was due, or a backup of a selection, deleted the only complete copy of the
// other apps.
test('a set of fewer apps does not supersede a set whose store never finished', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'backup-set-superseded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let installed = ['memos', 'wiki', 'photos'];
  const backup = loadPlatformBackup({
    '@/lib/market/metadata': { listInstalledApps: async () => installed.map(appId => ({ appId })) },
    './app-backup': { backupApp: async () => encryption },
    './core-backup': { backupCore: async () => encryption },
    '@/lib/spine/client': { spineClient: { async storeBackupSet() {} }, SpineAPIError: class extends Error {}, SpineTransportError },
    './workspace': { BACKUP_ROOT: root },
    './compatibility': { readCurrentBackupSourceIdentity: async () => ({ schema: 'youeye.backup.source.v1' }) },
    '@/lib/market/update-executor-lock': { AppUpdateExecutorLock: { acquire: () => ({ release() {} }) } },
    '@/lib/market/update-admission': { isAppUpdateReserved: (appId: string) => appId === 'photos' },
  });
  const sets = path.join(root, 'sets');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const keep = async (id: string, apps: string[] | undefined, record?: string) => {
    await mkdir(path.join(sets, id), { recursive: true });
    await writeFile(path.join(sets, id, 'backup-set.json'), record ?? JSON.stringify({ schema: 'youeye.backup.set.v1', id, status: 'completed', apps }));
    await writeFile(path.join(sets, `${id}.storing`), '');
  };
  const partial = 'backup-20261121T010201Z-00001111'; // memos only
  const full = 'backup-20261121T010202Z-00002222';    // memos, wiki, photos
  const other = 'backup-20261121T010203Z-00003333';   // wiki only: does not hold what `full` holds
  await keep(partial, ['memos']);
  await keep(full, ['memos', 'wiki', 'photos']);
  await keep(other, ['wiki']);
  const damaged = 'backup-20261121T010200Z-00000000';
  await keep(damaged, undefined, '{"schema":');
  const stored = async () => (await readdir(sets)).filter(name => name.endsWith('.storing')).map(name => name.slice(0, -8)).sort();

  // A scheduled backup of the one app that is due, to the drive. `partial` went at the start (the newer `full` holds
  // it), and so did the set that is no recovery point; `full` and `other` stay.
  await backup.createPlatformBackup({ useStoredPassphrase: true, selectedAppIds: ['memos'], mediaId: 'drive-1', reason: 'scheduled' }, () => {});
  assert.deepEqual(await stored(), [full, other], 'a set of one app deleted a kept set of three');
  // The core only.
  await backup.createPlatformBackup({ useStoredPassphrase: true, selectedAppIds: [], mediaId: 'drive-1', reason: 'scheduled' }, () => {});
  assert.deepEqual(await stored(), [full, other]);
  // Everything, but photos is skipped (its update is unfinished): `other` is held by the new set, `full` is not.
  await backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {});
  assert.deepEqual(await stored(), [full], 'a set that skipped an app deleted the only copy of it');
  assert.ok((await readdir(sets)).includes(full), 'the kept set itself is there');
  // photos is not installed any more: no later set can hold it, and it does not keep the set for ever.
  installed = ['memos', 'wiki'];
  await backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {});
  assert.deepEqual(await readdir(sets), [], 'a set that holds every installed app of the kept set supersedes it');
});

// A kept set whose record cannot be read just now (EIO, EACCES) says nothing: it is never deleted, and it covers no
// other kept set. Two of them covered each other, and one "covered" an older set of the core only.
test('a kept set whose record cannot be read neither goes nor supersedes another', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'backup-set-unreadable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fsp = await import('node:fs/promises');
  const unreadable = new Set<string>();
  const backup = loadPlatformBackup({
    'node:fs/promises': { ...fsp, readFile: async (file: unknown, ...rest: unknown[]) => {
      if (unreadable.has(String(file))) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return (fsp.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    } },
    '@/lib/market/metadata': { listInstalledApps: async () => [{ appId: 'memos' }] },
    './app-backup': { backupApp: async () => encryption },
    './core-backup': { backupCore: async () => encryption },
    '@/lib/spine/client': { spineClient: { async storeBackupSet() { throw new Error('the drive is not attached'); } }, SpineAPIError: class extends Error {}, SpineTransportError },
    './workspace': { BACKUP_ROOT: root },
    './compatibility': { readCurrentBackupSourceIdentity: async () => ({ schema: 'youeye.backup.source.v1' }) },
    '@/lib/market/update-executor-lock': { AppUpdateExecutorLock: { acquire: () => ({ release() {} }) } },
    '@/lib/market/update-admission': { isAppUpdateReserved: () => false },
  });
  const sets = path.join(root, 'sets');
  const coreOnly = 'backup-20261121T010201Z-00001111';
  const first = 'backup-20261121T010202Z-00002222';
  const second = 'backup-20261121T010203Z-00003333';
  for (const id of [coreOnly, first, second]) {
    await fsp.mkdir(path.join(sets, id), { recursive: true });
    await fsp.writeFile(path.join(sets, id, 'backup-set.json'), JSON.stringify({ schema: 'youeye.backup.set.v1', id, status: 'completed', apps: id === coreOnly ? [] : ['memos'] }));
    await fsp.writeFile(path.join(sets, `${id}.storing`), '');
    if (id !== coreOnly) unreadable.add(path.join(sets, id, 'backup-set.json'));
  }
  const kept = [coreOnly, `${coreOnly}.storing`, first, `${first}.storing`, second, `${second}.storing`].sort();
  await assert.rejects(backup.createPlatformBackup({ passphrase: 'a recovery key of length', mediaId: 'drive-1' }, () => {}), /not attached/);
  assert.deepEqual((await readdir(sets)).sort(), kept, 'an unreadable kept set was deleted, or superseded another');
});

// A set without a record (or a record without `encryption`) is an older set; a record that is there but cannot be
// read is refused, never read as an older set (a 0.6.15 set would then fail as "wrong passphrase").
test('a restore tells a damaged backup-set.json from a set made before it recorded the encryption', async t => {
  const { readBackupEncryption } = await import('../src/lib/backup/full-restore');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'backup-set-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  const set = async (record?: string) => {
    const dir = path.join(root, `set-${n++}`);
    await mkdir(dir, { recursive: true });
    if (record !== undefined) await writeFile(path.join(dir, 'backup-set.json'), record);
    return dir;
  };
  assert.equal(readBackupEncryption(await set()), undefined);
  assert.equal(readBackupEncryption(await set(JSON.stringify({ schema: 'youeye.backup.set.v1', status: 'completed' }))), undefined);
  assert.deepEqual(readBackupEncryption(await set(JSON.stringify({ encryption }))), encryption);
  for (const damaged of ['{"encryption": {"cipher"', '', 'null', '[]']) {
    const dir = await set(damaged);
    assert.throws(() => readBackupEncryption(dir), /backup-set\.json\) is damaged/, damaged);
  }
  const unreadable = await set();
  await mkdir(path.join(unreadable, 'backup-set.json'));
  assert.throws(() => readBackupEncryption(unreadable), /backup-set\.json\) cannot be read: EISDIR/);
});
