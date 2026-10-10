import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppServiceCredentialStore } from '../src/lib/apps/service-credential-store';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'app-credential-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AppServiceCredentialStore(directory) };
}

test('provision persists one opaque installation credential, including across process recreation', async t => {
  const { directory, store } = await fixture(t);
  const first = await store.provisionForInstall('wiki');
  const secret = await store.runtimeSecret('wiki');
  assert.ok(/^ye_app_v1_[A-Za-z0-9_-]{43}$/.test(secret));
  const restored = new AppServiceCredentialStore(directory);
  const repeated = await restored.provisionForInstall('wiki');
  assert.equal(repeated.installationId, first.installationId);
  assert.equal(repeated.generation, 1);
  assert.equal(repeated.revision, 1);
  assert.ok(secret === await restored.runtimeSecret('wiki'));
  assert.equal((await lstat(path.join(directory, 'wiki'))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(directory, 'wiki', 'credential.json'))).mode & 0o777, 0o600);
  const status = await store.status('wiki');
  assert.ok(status && !('verifierHash' in status) && !('secret' in status));
  assert.ok(!JSON.stringify(status).includes(secret));
});

test('prepared credentials deny authentication and activation makes only current material valid', async t => {
  const { store } = await fixture(t);
  const prepared = await store.provisionForInstall('wiki');
  const secret = await store.runtimeSecret('wiki');
  assert.ok(await store.authenticate('wiki', secret) === null);
  const active = await store.activate('wiki', prepared.revision);
  assert.equal(active.status, 'active');
  assert.ok(await store.authenticate('wiki', secret));
  assert.ok(await store.authenticate('notes', secret) === null);
  assert.ok(await store.authenticate('wiki', 'not-a-credential') === null);
  assert.equal((await store.activate('wiki', prepared.revision)).revision, active.revision);
});

test('rotation retries recover the prepared generation and immediately deny the retired secret', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  const oldSecret = await store.runtimeSecret('wiki');
  const active = await store.activate('wiki', 1);
  const pending = await store.prepareRotation('wiki', active.revision);
  const nextSecret = await store.runtimeSecret('wiki');
  assert.ok(oldSecret !== nextSecret);
  assert.equal(pending.installationId, active.installationId);
  assert.equal(pending.generation, 2);
  assert.ok(await store.authenticate('wiki', oldSecret) === null);
  assert.ok(await store.authenticate('wiki', nextSecret) === null);
  const restarted = new AppServiceCredentialStore(directory);
  const retry = await restarted.prepareRotation('wiki', active.revision);
  assert.equal(retry.revision, pending.revision);
  assert.ok(await restarted.runtimeSecret('wiki') === nextSecret);
  await restarted.activate('wiki', pending.revision);
  assert.ok(await restarted.authenticate('wiki', nextSecret));
  assert.ok(await restarted.authenticate('wiki', oldSecret) === null);
  await assert.rejects(restarted.prepareRotation('wiki', active.revision), /revision conflict/);
});

test('revocation erases protected secret and normal reconciliation cannot resurrect it', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  const oldSecret = await store.runtimeSecret('wiki');
  const active = await store.activate('wiki', 1);
  const revoked = await store.revoke('wiki', active.revision);
  assert.equal(revoked.status, 'revoked');
  assert.equal((await store.revoke('wiki', active.revision)).revision, revoked.revision);
  assert.ok(await store.authenticate('wiki', oldSecret) === null);
  await assert.rejects(store.runtimeSecret('wiki'), /integration is not ready/);
  await assert.rejects(store.provisionForInstall('wiki'), /explicit adoption/);
  await assert.rejects(store.activate('wiki', revoked.revision), /generation conflict/);
  const persisted = await readFile(path.join(directory, 'wiki', 'credential.json'), 'utf8');
  assert.ok(!persisted.includes(oldSecret));
  const reinstall = await store.prepareReinstall('wiki', revoked.revision);
  const replacementSecret = await store.runtimeSecret('wiki');
  assert.notEqual(reinstall.installationId, revoked.installationId);
  assert.equal(reinstall.generation, 1);
  assert.ok(replacementSecret !== oldSecret);
  const retry = await store.prepareReinstall('wiki', revoked.revision);
  assert.equal(retry.installationId, reinstall.installationId);
  assert.ok(await store.runtimeSecret('wiki') === replacementSecret);
  await store.activate('wiki', reinstall.revision);
  assert.ok(await store.authenticate('wiki', replacementSecret));
  assert.ok(await store.authenticate('wiki', oldSecret) === null);
});

test('competing writers across store instances cannot mint different successful generations', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  await store.activate('wiki', 1);
  const outcomes = await Promise.allSettled([
    store.prepareRotation('wiki', 2),
    new AppServiceCredentialStore(directory).prepareRotation('wiki', 2),
  ]);
  const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  assert.equal((await store.projection('wiki'))?.generation, 2);
});

test('missing or corrupt protected record requires repair, never a new guessed secret', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  await rm(path.join(directory, 'wiki', 'credential.json'));
  await assert.rejects(store.runtimeSecret('wiki'), /requires repair/);
  await assert.rejects(store.provisionForInstall('wiki'), /requires repair/);
  assert.ok(await store.authenticate('wiki', 'ye_app_v1_' + 'a'.repeat(43)) === null);
  await writeFile(path.join(directory, 'wiki', 'credential.json'), '{corrupt', { mode: 0o600 });
  await assert.rejects(store.provisionForInstall('wiki'), /requires repair/);
});

test('unsafe storage and symlink credentials are rejected', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  const record = path.join(directory, 'wiki', 'credential.json');
  await chmod(record, 0o644);
  await assert.rejects(store.runtimeSecret('wiki'), /requires repair/);
  await rm(record);
  await symlink(path.join(directory, 'outside.json'), record);
  await assert.rejects(store.provisionForInstall('wiki'), /requires repair/);
  await chmod(directory, 0o755);
  await assert.rejects(store.provisionForInstall('notes'), /storage is unsafe/);
});

test('write failure returns no ephemeral credential and leaves an explicit repair condition', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  await rm(path.join(directory, 'wiki', 'credential.json'));
  await mkdir(path.join(directory, 'wiki', 'credential.json'), { mode: 0o700 });
  await assert.rejects(store.runtimeSecret('wiki'), /requires repair/);
  await assert.rejects(store.provisionForInstall('wiki'), /requires repair/);
  assert.ok(await store.authenticate('wiki', 'ye_app_v1_' + 'a'.repeat(43)) === null);
});

test('unknown locks require repair and known dead owners can be reconciled', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  const lock = path.join(directory, 'wiki.lock');
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(store.prepareRotation('wiki', 1), /operation is pending/);
  await assert.rejects(store.recoverAbandonedOperation('wiki'), /lock requires repair/);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    pid: 2147483647, bootId: '00000000-0000-4000-8000-000000000000', started: '1',
  }), { mode: 0o600 });
  await store.recoverAbandonedOperation('wiki');
  assert.equal((await store.activate('wiki', 1)).status, 'active');
});

test('live process identity prevents a reconcile from stealing a lock', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  const lock = path.join(directory, 'wiki.lock');
  await mkdir(lock, { mode: 0o700 });
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    pid: process.pid,
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    started: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
  }), { mode: 0o600 });
  await assert.rejects(store.recoverAbandonedOperation('wiki'), /still running/);
});

test('path traversal and unregistered identities fail closed', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.provisionForInstall('../wiki'), /Invalid app credential identity/);
  await assert.rejects(store.runtimeSecret('notes'), /integration is not ready/);
});

test('persistence failure before atomic rename yields repair rather than an ephemeral token', async t => {
  const { directory } = await fixture(t);
  const failing = new AppServiceCredentialStore(directory, async boundary => {
    if (boundary === 'file-synced') throw new Error('fixture storage failure');
  });
  await assert.rejects(failing.provisionForInstall('wiki'), /persistence failed/);
  const restarted = new AppServiceCredentialStore(directory);
  await assert.rejects(restarted.runtimeSecret('wiki'), /requires repair/);
  await assert.rejects(restarted.provisionForInstall('wiki'), /requires repair/);
});

test('ambiguous failure after atomic rename retries the persisted generation without reminting', async t => {
  const { directory } = await fixture(t);
  const failing = new AppServiceCredentialStore(directory, async boundary => {
    if (boundary === 'renamed') throw new Error('fixture storage failure');
  });
  await assert.rejects(failing.provisionForInstall('wiki'), /persistence failed/);
  const restarted = new AppServiceCredentialStore(directory);
  const saved = await restarted.projection('wiki');
  const secret = await restarted.runtimeSecret('wiki');
  const retried = await restarted.provisionForInstall('wiki');
  assert.ok(saved);
  assert.equal(saved.installationId, retried.installationId);
  assert.equal(saved.generation, retried.generation);
  assert.ok(secret === await restarted.runtimeSecret('wiki'));
});

test('optional expiry denies a persisted current credential', async t => {
  const { directory, store } = await fixture(t);
  await store.provisionForInstall('wiki');
  await store.activate('wiki', 1);
  const secret = await store.runtimeSecret('wiki');
  const file = path.join(directory, 'wiki', 'credential.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.projection.expiresAt = saved.projection.createdAt;
  for (const publication of saved.publications) publication.expiresAt = saved.projection.expiresAt;
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  assert.ok(await store.authenticate('wiki', secret) === null);
});

test('readers cannot receive a secret while its durable commit is still pending', async t => {
  const { directory } = await fixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const renamed = new Promise<void>(resolve => { reached = resolve; });
  const writer = new AppServiceCredentialStore(directory, async boundary => {
    if (boundary === 'renamed') { reached(); await pending; }
  });
  const writing = writer.provisionForInstall('wiki');
  try {
    await renamed;
    const reader = new AppServiceCredentialStore(directory);
    await assert.rejects(reader.runtimeSecret('wiki'), /operation is pending/);
    await assert.rejects(reader.projection('wiki'), /operation is pending/);
  } finally { release(); }
  await writing;
  assert.ok(await new AppServiceCredentialStore(directory).runtimeSecret('wiki'));
});
