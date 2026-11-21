import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ARCHIVE_STEP_TIMEOUT_MS, BACKUP_STEP_TIMEOUT_MS, SpineClient } from '../src/lib/spine/client';

// Spine waits up to 90 s to admit a backup or restore archive step while a System update or a Control Panel
// restart holds the admission gate (OrdinaryAdmissionWait). The Control Panel must not give up first. In six steps
// Spine does the whole work before it answers (the archive restore, the volume restore, the Incus prepare and
// import, the drive store and import). Spine ends each of them itself after 6 hours (StepCeiling in
// spine/internal/backup/step.go), so the Control Panel waits a little longer than that: it gets Spine's answer, and
// it always ends, also when Spine hangs (it holds the lifecycle lock and the backup operation lock meanwhile).
const source = { schema: 'youeye.backup.source.v1', runtime_kind: 'mutable-host', spine_version: '0.6.15' } as never;
const longSteps = (client: SpineClient): Array<() => Promise<unknown>> => [
  () => client.restoreArchive({ archive_path: '/x', passphrase: 'p', staging_dir: '/y' }),
  () => client.applyBackupVolumes('/y'),
  () => client.prepareIncusRecovery('/y'),
  () => client.importIncusInstance({ archivePath: '/y/i.tar.gz', name: 'app', pool: 'default', network: 'yeapp1' }),
  () => client.storeBackupSet({ media_id: 'm', backup_id: 'b', apps: [], created_at: '', size_bytes: 0, reason: 'manual', source }),
  () => client.importBackupSet({ media_id: 'm', backup_id: 'b' }),
];

test('a backup archive step outwaits Spine\'s admission wait, and the long steps outwait Spine\'s 6 hours', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-archive-'));
  const socket = join(root, 'youeye.sock');
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const waits: number[] = [];
  const original = http.ClientRequest.prototype.setTimeout;
  t.mock.method(http.ClientRequest.prototype, 'setTimeout', function (this: http.ClientRequest, ms: number, callback?: () => void) {
    waits.push(ms);
    return original.call(this, ms, callback);
  });

  const client = new SpineClient(socket);
  await client.startBackup({ target_path: '/x', containers: [], staging_dir: '/y', hostname: 'box', backup_type: 'core' });
  for (const step of longSteps(client)) await step();
  await client.getBackupStatus();

  const spineAdmissionWaitMs = 90_000;
  const spineStepCeilingMs = 6 * 60 * 60_000;
  assert.ok(ARCHIVE_STEP_TIMEOUT_MS >= spineAdmissionWaitMs + 60_000);
  assert.ok(BACKUP_STEP_TIMEOUT_MS >= spineStepCeilingMs + 5 * 60_000, 'Spine ends the step first and its answer is read');
  assert.ok(BACKUP_STEP_TIMEOUT_MS < 2 ** 31, 'a longer timer would fire at once');
  assert.deepEqual(waits, [ARCHIVE_STEP_TIMEOUT_MS, ...longSteps(client).map(() => BACKUP_STEP_TIMEOUT_MS), 60_000],
    'every long step has the long limit, and none has no limit');
});

// A long step waits far longer than an ordinary call, ends when Spine goes away, and ends by itself when Spine
// never answers (it used to wait for ever, holding both locks).
test('a restore archive step outwaits an ordinary call, and still ends when Spine never answers or goes away', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-restore-'));
  const socket = join(root, 'youeye.sock');
  let answer: (() => void) | undefined;
  let drop: (() => void) | undefined;
  const server = http.createServer((_request, response) => {
    answer = () => { response.setHeader('Content-Type', 'application/json'); response.end('{"staging_dir":"/y","message":"done"}'); };
    drop = () => response.socket?.destroy();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  // The long limit becomes 600 ms and every other limit 50 ms, so both show up within the test.
  const original = http.ClientRequest.prototype.setTimeout;
  t.mock.method(http.ClientRequest.prototype, 'setTimeout', function (this: http.ClientRequest, ms: number, callback?: () => void) {
    return original.call(this, ms === BACKUP_STEP_TIMEOUT_MS ? 600 : 50, callback);
  });
  const client = new SpineClient(socket);

  let settled = false;
  const restore = client.restoreArchive({ archive_path: '/x', passphrase: 'p', staging_dir: '/y' });
  restore.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(settled, false, 'the restore step is still waiting for Spine');
  answer?.();
  assert.deepEqual(await restore, { staging_dir: '/y', message: 'done' });

  // The same silence ends an ordinary call at once.
  await assert.rejects(client.getBackupStatus(), /Request timeout/);

  // A Spine that never answers: the long step ends too.
  await assert.rejects(client.restoreArchive({ archive_path: '/x', passphrase: 'p', staging_dir: '/y' }), /Request timeout/);

  // Spine stopping (its socket closing) ends the wait with an error.
  const cut = client.restoreArchive({ archive_path: '/x', passphrase: 'p', staging_dir: '/y' });
  const cutOutcome = assert.rejects(cut, /transport error|socket hang up/i);
  await new Promise(resolve => setTimeout(resolve, 100));
  drop?.();
  await cutOutcome;
});
