import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  AppUpdateJournalStore, updateResourceKey, type NewAppUpdate, type UpdateResource,
} from '../src/lib/market/update-journal';

const hash = 'a'.repeat(64);
const resources: UpdateResource[] = [
  { kind: 'app', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: false },
  { kind: 'container', scope: 'incus', name: 'app-fixture', ownerAppId: 'fixture', mutable: true },
  { kind: 'volume', scope: 'default', name: 'ye-fixture-data', ownerAppId: 'fixture', mutable: true },
  { kind: 'database', scope: 'youeye-postgres', name: 'fixture', ownerAppId: 'fixture', mutable: true },
  { kind: 'metadata', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: true },
];
const input: NewAppUpdate = {
  appId: 'fixture', source: { manifestSHA256: hash, artifactSHA256: [hash] },
  target: { manifestSHA256: hash, artifactSHA256: [hash] },
  resources, originalRunning: { 'app-fixture': false }, metadataBeforeSHA256: hash,
};

function temporary(work: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-app-journal-'));
  try { work(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function prepared(store: AppUpdateJournalStore) {
  const lease = store.create(input);
  lease.transition('quiescing');
  lease.transition('checkpointing');
  for (const resource of resources.filter(r => r.mutable)) {
    lease.checkpoint({ resource: updateResourceKey(resource),
      method: resource.kind === 'database' ? 'logical-postgres'
        : resource.kind === 'container' ? 'runtime-copy'
          : resource.kind === 'volume' ? 'volume-snapshot' : 'scoped-metadata',
      reference: `point-${resource.kind}`, sha256: hash, verifiedAt: new Date().toISOString() });
  }
  lease.transition('prepared');
  return lease;
}

test('capacity admission excludes another app from spending the same free-space estimate', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const make = (appId: string): NewAppUpdate => ({
    ...input, appId, originalRunning: {},
    resources: [
      { kind: 'app', scope: 'market', name: appId, ownerAppId: appId, mutable: false },
      { kind: 'capacity', scope: 'incus-pool', name: 'default', ownerAppId: appId, mutable: false },
    ],
  });
  const first = store.create(make('first'));
  first.release();
  assert.throws(() => store.create(make('second')), /reserved/);
  const recovered = store.resume(first.snapshot().id);
  recovered.transition('recovering');
  recovered.rolledBack();
  recovered.transition('cleanup');
  recovered.finishCleanup();
  store.create(make('second')).release();
  assert.throws(() => store.create({ ...make('third'),
    resources: make('third').resources.map(r => ({ ...r, mutable: r.kind === 'capacity' })) }), /corrupt/);
}));

test('verified commit remains durable through cleanup failure and cannot enter rollback', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = prepared(store);
  lease.transition('applying');
  lease.intent('first-start-migration');
  assert.throws(() => lease.intent('first-start-migration'), /reconcile/);
  lease.complete('first-start-migration');
  lease.transition('verifying');
  lease.intent('publish-metadata');
  assert.throws(() => lease.commit(hash), /unfinished/);
  lease.complete('publish-metadata');
  lease.commit(hash);
  lease.transition('cleanup');
  lease.intent('remove-checkpoints');
  assert.throws(() => lease.finishCleanup(), /not verified/);
  assert.throws(() => lease.recoveryRequired('cleanup-failed'), /cannot be turned/);
  assert.equal(new AppUpdateJournalStore(directory).read(lease.snapshot().id).commit?.metadataAfterSHA256, hash);
  assert.equal(store.isReserved(resources[0]), true);
  lease.complete('remove-checkpoints');
  lease.finishCleanup();
  assert.equal(store.read(lease.snapshot().id).cleanupComplete, true);
  assert.equal(store.isReserved(resources[0]), false);
  assert.deepEqual(readdirSync(path.join(directory, 'locks')), []);
}));

test('no prepared checkpoint or false rollback with unfinished external intent', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = store.create(input);
  assert.throws(() => lease.transition('applying'), /Invalid/);
  lease.transition('quiescing');
  lease.transition('checkpointing');
  assert.throws(() => lease.transition('prepared'), /every mutable resource/);
  lease.intent('volume-copy');
  lease.transition('recovering');
  assert.throws(() => lease.rolledBack(), /reconcile/);
  lease.recoveryRequired('checkpoint-missing');
  assert.equal(store.isReserved(resources[2]), true);
  assert.throws(() => store.create(input), /reserved/);
  lease.transition('recovering');
  lease.complete('volume-copy');
  lease.rolledBack();
  lease.transition('cleanup');
  lease.finishCleanup();
  assert.equal(store.isReserved(resources[2]), false);
}));

test('foreign resource ownership and credential/SQL payloads fail before journal creation', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  assert.throws(() => store.create({ ...input, resources: [
    resources[0], { ...resources[1], ownerAppId: 'other' },
  ] }), /corrupt or insecure/);
  assert.throws(() => store.create({ ...input, password: 'example' } as NewAppUpdate), /corrupt or insecure/);
  assert.throws(() => store.create({ ...input, target: {
    ...input.target, sql: 'UPDATE example',
  } } as NewAppUpdate), /corrupt or insecure/);
  assert.deepEqual(store.list(), []);
}));

test('resource acquisition failure releases only the new operation reservations', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const first = store.create(input);
  const changed = { ...input, appId: 'another', resources: [
    { ...resources[0], name: 'another', ownerAppId: 'another' },
    { ...resources[2], ownerAppId: 'another' },
  ], originalRunning: {} };
  assert.throws(() => store.create(changed), /reserved/);
  assert.equal(store.read(first.snapshot().id).cleanupComplete, false);
  assert.equal(store.isReserved(resources[2]), true);
  assert.equal(store.isReserved(changed.resources[0]), false);
  assert.equal(readdirSync(path.join(directory, 'locks')).length, resources.length);
}));

test('partially acquired reservations do not remove an unknown pre-existing lock', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const keys = resources.map(updateResourceKey).sort();
  const orphan = path.join(directory, 'locks', keys[2]);
  mkdirSync(orphan, { mode: 0o700 });
  assert.throws(() => store.create(input), /EEXIST/);
  assert.deepEqual(readdirSync(path.join(directory, 'locks')), [keys[2]]);
  assert.equal(store.list()[0].cleanupComplete, true);
  assert.equal(store.isReserved(resources.find(r => updateResourceKey(r) === keys[2])!), true);
}));

test('a dead process retains journal intent and resource reservations for restart recovery', () => temporary(directory => {
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    const lease = new AppUpdateJournalStore(process.argv[1]).create(JSON.parse(process.argv[2]));
    lease.transition('quiescing');
    lease.intent('stop-writers');
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, JSON.stringify(input)]);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const restarted = new AppUpdateJournalStore(directory);
  const [record] = restarted.list();
  assert.equal(record.phase, 'quiescing');
  assert.equal(record.steps[0].state, 'intent');
  assert.equal(restarted.isReserved(resources[1]), true);
  assert.throws(() => restarted.create(input), /reserved/);
  assert.equal(restarted.read(record.id).originalRunning['app-fixture'], false);
}));

test('an unfinished receipt excludes admission even if every reservation directory is missing', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = store.create(input);
  for (const entry of readdirSync(path.join(directory, 'locks'))) {
    rmSync(path.join(directory, 'locks', entry), { recursive: true });
  }
  assert.equal(store.isReserved(resources[0]), true);
  assert.throws(() => store.create(input), /reserved/);
  assert.equal(store.list().length, 1);
  assert.equal(store.read(lease.snapshot().id).phase, 'preflight');
}));

test('a second live process cannot acquire resources held by the first process', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const first = store.create(input);
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    try { new AppUpdateJournalStore(process.argv[1]).create(JSON.parse(process.argv[2])); process.exit(1); }
    catch (error) { process.exit(error.message.includes('reserved') ? 0 : 2); }
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, JSON.stringify(input)], { timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr.toString());
  assert.equal(store.list().length, 1);
  assert.equal(store.read(first.snapshot().id).revision, 0);
}));

test('caller mutation cannot replace resource coverage or a verified checkpoint receipt', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const callerInput = structuredClone(input);
  const lease = store.create(callerInput);
  callerInput.resources.forEach(r => { r.mutable = false; });
  lease.transition('quiescing');
  lease.transition('checkpointing');
  assert.throws(() => lease.transition('prepared'), /every mutable/);
  const checkpoint = { resource: updateResourceKey(resources[1]),
    method: 'runtime-copy' as const, reference: 'original', sha256: hash, verifiedAt: new Date().toISOString() };
  lease.checkpoint(checkpoint);
  checkpoint.reference = 'substituted';
  lease.intent('another-step');
  assert.equal(store.read(lease.snapshot().id).checkpoints[0].reference, 'original');
}));

test('checkpoint methods must cover the actual resource kind', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = store.create(input);
  lease.transition('quiescing');
  lease.transition('checkpointing');
  assert.throws(() => lease.checkpoint({ resource: updateResourceKey(resources[1]),
    method: 'scoped-metadata', reference: 'metadata', sha256: hash, verifiedAt: new Date().toISOString() }),
  /corrupt or insecure/);
  assert.equal(lease.snapshot().checkpoints.length, 0);
}));

test('corrupt terminal receipts cannot hide unfinished mutations or missing checkpoint coverage', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = prepared(store);
  lease.transition('applying');
  lease.transition('verifying');
  lease.commit(hash);
  lease.transition('cleanup');
  const file = path.join(directory, 'operations', `${lease.snapshot().id}.json`);
  const record = lease.snapshot();
  writeFileSync(file, JSON.stringify({ ...record, cleanupComplete: true, checkpoints: [] }));
  assert.throws(() => store.read(record.id), /corrupt or insecure/);
  writeFileSync(file, JSON.stringify({ ...record, cleanupComplete: true,
    steps: [{ id: 'unfinished', phase: 'applying', state: 'intent' }] }));
  assert.equal(store.isReserved(resources[0]), true);
  writeFileSync(file, JSON.stringify({ ...record, rollbackVerifiedAt: new Date().toISOString() }));
  assert.throws(() => store.read(record.id), /corrupt or insecure/);
}));

test('a FIFO journal entry is rejected promptly rather than blocking the event loop', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = store.create(input);
  const file = path.join(directory, 'operations', `${lease.snapshot().id}.json`);
  rmSync(file);
  const fifo = spawnSync('mkfifo', ['-m', '600', file]);
  assert.equal(fifo.status, 0, fifo.stderr.toString());
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    try { new AppUpdateJournalStore(process.argv[1]).read(process.argv[2]); process.exit(1); }
    catch { process.exit(0); }
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, lease.snapshot().id], { timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr.toString());
}));

test('growth after stat cannot bypass the journal byte limit', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = store.create(input);
  const file = path.join(directory, 'operations', `${lease.snapshot().id}.json`);
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const fs = require('node:fs');
    const original = fs.fstatSync;
    fs.fstatSync = (fd) => {
      const result = original(fd);
      if (result.isFile()) fs.appendFileSync(process.argv[3], ' '.repeat(2 * 1024 * 1024));
      return result;
    };
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    try { new AppUpdateJournalStore(process.argv[1]).read(process.argv[2]); process.exit(1); }
    catch { process.exit(0); }
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, lease.snapshot().id, file], { timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr.toString());
}));

test('interrupted reservation release remains pending and resumes without false rollback', () => temporary(directory => {
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const fs = require('node:fs');
    const { AppUpdateJournalStore, updateResourceKey } = require(${JSON.stringify(modulePath)});
    const input = JSON.parse(process.argv[2]);
    const store = new AppUpdateJournalStore(process.argv[1]);
    const lease = store.create(input);
    lease.transition('quiescing'); lease.transition('checkpointing');
    for (const r of input.resources.filter(r => r.mutable)) {
      const method = { container: 'runtime-copy', volume: 'volume-snapshot',
        database: 'logical-postgres', metadata: 'scoped-metadata' }[r.kind];
      lease.checkpoint({ resource: updateResourceKey(r), method, reference: 'point',
        sha256: input.metadataBeforeSHA256, verifiedAt: new Date().toISOString() });
    }
    lease.transition('prepared'); lease.transition('applying'); lease.transition('verifying');
    lease.commit(input.metadataBeforeSHA256); lease.transition('cleanup');
    const original = fs.rmdirSync;
    let failed = false;
    fs.rmdirSync = (dir) => {
      original(dir);
      if (dir.includes('/locks/') && !failed) { failed = true; throw new Error('lost acknowledgement'); }
    };
    try { lease.finishCleanup(); } catch {}
    if (store.read(lease.snapshot().id).cleanupComplete) process.exit(1);
    lease.finishCleanup();
    lease.finishCleanup();
    if (!store.read(lease.snapshot().id).cleanupComplete
      || fs.readdirSync(process.argv[1] + '/locks').length) process.exit(2);
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, JSON.stringify(input)], { timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr.toString());
}));

test('symlinked or public state and corrupt records fail closed', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = store.create(input);
  const file = path.join(directory, 'operations', `${lease.snapshot().id}.json`);
  const original = readFileSync(file);
  chmodSync(file, 0o644);
  assert.throws(() => store.read(lease.snapshot().id), /corrupt or insecure/);
  assert.equal(store.isReserved(resources[0]), true);
  chmodSync(file, 0o600);
  writeFileSync(file, '{bad JSON');
  assert.equal(store.isReserved(resources[0]), true);
  writeFileSync(file, original);
  const link = path.join(directory, 'link');
  symlinkSync(directory, link);
  assert.throws(() => new AppUpdateJournalStore(link), /corrupt or insecure/);
}));

test('resume excludes a live executor, reads the latest revision and fences released leases', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const original = store.create(input);
  const id = original.snapshot().id;
  original.intent('pending-effect');
  assert.throws(() => new AppUpdateJournalStore(directory).resume(id), /busy/);
  original.release();
  const successor = store.resume(id);
  try {
    assert.equal(successor.snapshot().revision, 1);
    assert.equal(successor.snapshot().steps[0].state, 'intent');
    assert.throws(() => original.complete('pending-effect'), /released/);
    assert.throws(() => original.transition('preflight'), /released/);
    successor.transition('recovering');
    assert.throws(() => successor.rolledBack(), /reconcile/);
    successor.complete('pending-effect');
    successor.rolledBack();
    successor.transition('cleanup');
    successor.finishCleanup();
    assert.throws(() => store.resume(id), /already cleaned up/);
    assert.equal(store.isReserved(resources[0]), false);
  } finally { successor.release(); }
}));

test('withExecutor retains exclusive ownership across awaits and releases after callback failure', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-app-journal-'));
  try {
    const store = new AppUpdateJournalStore(directory);
    let id!: string;
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const pending = store.withExecutor(input, async lease => {
      id = lease.snapshot().id;
      lease.intent('pending-effect');
      await wait;
      lease.assertActive();
      throw new Error('adapter-failed');
    });
    assert.throws(() => store.resume(id), /busy/);
    finish();
    await assert.rejects(pending, /adapter-failed/);
    await store.withExecutor(id, async lease => {
      assert.equal(lease.snapshot().steps[0].state, 'intent');
      assert.equal(store.isReserved(resources[0]), true);
      assert.throws(() => store.resume(id), /busy/);
    });
    const lease = store.resume(id);
    lease.release();
    assert.throws(() => store.create(input), /reserved/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL of an async admission owner releases admission while preserving incomplete receipts', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-app-journal-'));
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    const store = new AppUpdateJournalStore(process.argv[1]);
    const lease = store.create(JSON.parse(process.argv[2]));
    lease.intent('pending-effect');
    store.withAdmission(async () => {
      process.stdout.write(lease.snapshot().id + '\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
    }).catch(() => process.exit(3));
  `;
  const child = spawn(process.execPath,
    ['--import', 'tsx', '-e', source, directory, JSON.stringify(input)]);
  t.after(() => { child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  const output = await Promise.race([
    once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Admission owner exited before readiness'); }),
  ]);
  const id = String(output[0]).trim();
  const store = new AppUpdateJournalStore(directory);
  const inode = lstatSync(path.join(directory, 'admission.flock')).ino;
  assert.throws(() => store.withAdmission(() => {}), /busy/);
  assert.throws(() => store.create(input), /busy/);
  assert.throws(() => store.resume(id), /busy/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  await store.withAdmission(async () => { await Promise.resolve(); });
  assert.equal(lstatSync(path.join(directory, 'admission.flock')).ino, inode);
  assert.throws(() => store.create(input), /reserved/);
  const lease = store.resume(id);
  try {
    assert.equal(lease.snapshot().steps[0].state, 'intent');
    assert.equal(store.isReserved(resources[0]), true);
  } finally { lease.release(); }
});

test('an empty legacy admission guard is recovered, but nonempty or insecure guards fail closed', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const legacy = path.join(directory, 'admission.lock');
  mkdirSync(legacy, { mode: 0o700 });
  assert.equal(store.withAdmission(() => 7), 7);
  assert.throws(() => lstatSync(legacy), /ENOENT/);
  mkdirSync(legacy, { mode: 0o700 });
  writeFileSync(path.join(legacy, 'unknown'), 'unknown');
  assert.throws(() => store.withAdmission(() => {}), /ENOTEMPTY/);
  rmSync(legacy, { recursive: true });
  mkdirSync(legacy, { mode: 0o755 });
  assert.throws(() => store.withAdmission(() => {}), /corrupt or insecure/);
}));

test('recovery can release missing reservations but never deletes a foreign owner', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const original = store.create(input);
  const id = original.snapshot().id;
  original.release();
  for (const entry of readdirSync(path.join(directory, 'locks'))) {
    rmSync(path.join(directory, 'locks', entry), { recursive: true });
  }
  const lease = store.resume(id);
  lease.transition('recovering');
  lease.rolledBack();
  lease.transition('cleanup');
  const key = resources.map(updateResourceKey).sort().at(-1)!;
  const foreign = path.join(directory, 'locks', key);
  mkdirSync(foreign, { mode: 0o700 });
  writeFileSync(path.join(foreign, 'owner'), '00000000-0000-4000-8000-000000000000', { mode: 0o600 });
  assert.throws(() => lease.finishCleanup(), /corrupt or insecure/);
  assert.equal(store.read(id).cleanupComplete, false);
  assert.equal(readFileSync(path.join(foreign, 'owner'), 'utf8'), '00000000-0000-4000-8000-000000000000');
  rmSync(foreign, { recursive: true });
  lease.finishCleanup();
  assert.equal(store.read(id).cleanupComplete, true);
}));

test('SIGKILL inside create releases admission and preserves the published inventory before reservations', () => temporary(directory => {
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const fs = require('node:fs');
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    const original = fs.mkdirSync;
    fs.mkdirSync = (dir, options) => {
      if (dir.includes('/locks/')) process.kill(process.pid, 'SIGKILL');
      return original(dir, options);
    };
    new AppUpdateJournalStore(process.argv[1]).create(JSON.parse(process.argv[2]));
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, JSON.stringify(input)], { timeout: 30_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const store = new AppUpdateJournalStore(directory);
  const [record] = store.list();
  assert.equal(record.phase, 'preflight');
  assert.equal(record.cleanupComplete, false);
  assert.deepEqual(readdirSync(path.join(directory, 'locks')), []);
  assert.throws(() => store.create(input), /reserved/);
  const lease = store.resume(record.id);
  lease.transition('recovering');
  lease.rolledBack();
  lease.transition('cleanup');
  lease.finishCleanup();
  assert.equal(store.read(record.id).cleanupComplete, true);
}));

test('SIGKILL inside final release allows exclusive recovery without losing commit or release intent', () => temporary(directory => {
  const store = new AppUpdateJournalStore(directory);
  const lease = prepared(store);
  lease.transition('applying');
  lease.transition('verifying');
  lease.commit(hash);
  lease.transition('cleanup');
  const id = lease.snapshot().id;
  lease.release();
  const inode = lstatSync(path.join(directory, 'executors', `${id}.lock`)).ino;
  const modulePath = path.resolve('src/lib/market/update-journal.ts');
  const source = `
    const fs = require('node:fs');
    const { AppUpdateJournalStore } = require(${JSON.stringify(modulePath)});
    const lease = new AppUpdateJournalStore(process.argv[1]).resume(process.argv[2]);
    const original = fs.rmdirSync;
    fs.rmdirSync = (dir) => {
      original(dir);
      if (dir.includes('/locks/')) process.kill(process.pid, 'SIGKILL');
    };
    lease.finishCleanup();
  `;
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '-e', source, directory, id], { timeout: 30_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const record = store.read(id);
  assert.equal(record.commit?.metadataAfterSHA256, hash);
  assert.equal(record.cleanupComplete, false);
  assert.equal(record.steps.filter(s => s.id.startsWith('release-') && s.state === 'intent').length, 1);
  assert.throws(() => store.create(input), /reserved/);
  const successor = store.resume(id);
  successor.finishCleanup();
  assert.equal(store.read(id).cleanupComplete, true);
  assert.deepEqual(readdirSync(path.join(directory, 'locks')), []);
  assert.equal(lstatSync(path.join(directory, 'executors', `${id}.lock`)).ino, inode);
  assert.throws(() => successor.intent('escaped-effect'), /no longer permits/);
}));
