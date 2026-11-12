import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import test from 'node:test';
import {
  AppUpdateJournalStore, updateResourceKey, type AppUpdatePhase, type AppUpdateRecord,
  type NewAppUpdate, type UpdateCheckpoint, type UpdateResource,
} from '../src/lib/market/update-journal';
import {
  AppUpdateTransaction, runAppUpdateTransaction, type AppUpdateProvider,
} from '../src/lib/market/update-transaction';

// This fixture models observable durable state, not Incus or PostgreSQL behavior.
// Each resource has its own file so interrupted restore can leave a mixed set.
const parts = ['runtime', 'worker', 'volume', 'database', 'metadata'] as const;
type Part = typeof parts[number];
type SetState = Record<Part, unknown>;
type Gates = { running: Record<string, boolean>; ingress: boolean; sql: boolean; jobs: boolean; migration: boolean };
type Event = { name: string; state: SetState; gates: Gates };
type Fault = { point: string; edge: 'before' | 'after'; action?: 'kill' };
const resources: UpdateResource[] = [
  { kind: 'app', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: false },
  { kind: 'container', scope: 'incus', name: 'app-fixture', ownerAppId: 'fixture', mutable: true },
  { kind: 'container', scope: 'incus', name: 'app-worker', ownerAppId: 'fixture', mutable: true },
  { kind: 'volume', scope: 'default', name: 'fixture-data', ownerAppId: 'fixture', mutable: true },
  { kind: 'database', scope: 'postgres', name: 'fixture', ownerAppId: 'fixture', mutable: true },
  { kind: 'metadata', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: true },
];
const resourceParts = new Map(resources.slice(1).map((r, i) => [updateResourceKey(r), parts[i]]));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oldSet: SetState = {
  runtime: { code: 'v1', files: { '/app/main': 'old server', '/etc/app': 'retain setting' } },
  worker: { code: 'v1', files: { '/app/job': 'old worker' } },
  volume: { files: { 'user/document': 'user content', 'cache/index': 'old format' } },
  database: { schema: ['id', 'body'], rows: [{ id: 1, body: 'user content' }], migrations: [] },
  metadata: { install: { version: 'v1', secret: 'fixture-private-value' }, manifest: 'v1', gateVersion: 'v1' },
};
const newSet: SetState = {
  runtime: { code: 'v2', files: { '/app/main': 'new server', '/etc/app': 'retain setting' } },
  worker: { code: 'v2', files: { '/app/job': 'new worker' } },
  volume: { files: { 'user/document': 'converted content', 'cache/index': 'new format', 'startup': 'ran once' } },
  database: {
    schema: ['id', 'body', 'format', 'startup_revision'],
    rows: [{ id: 1, body: 'converted content', format: 2, startup_revision: 1 }],
    migrations: ['explicit-sql', 'first-start'],
  },
  metadata: { install: { version: 'v2', secret: 'fixture-private-value' }, manifest: 'v2', gateVersion: 'v2' },
};
const foreignState = { volume: { 'other/file': 'untouched' }, database: { schema: ['legacy'], rows: [99] }, install: 'other-v7' };

function syncDirectory(directory: string) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.pending`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

function load<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')); }
function state(root: string): SetState {
  return Object.fromEntries(parts.map(p => [p, load(path.join(root, 'live', `${p}.json`))])) as SetState;
}
function gates(root: string): Gates { return load(path.join(root, 'live', 'gates.json')); }
function events(root: string): Event[] {
  const file = path.join(root, 'events.ndjson');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
}
function input(root: string): NewAppUpdate {
  return {
    appId: 'fixture',
    source: { manifestSHA256: hash('v1'), artifactSHA256: [hash(oldSet.runtime)] },
    target: { manifestSHA256: hash('v2'), artifactSHA256: [hash(newSet.runtime)] },
    resources: structuredClone(resources), originalRunning: load<Gates>(path.join(root, 'original-gates.json')).running,
    metadataBeforeSHA256: hash(oldSet.metadata),
  };
}
function seed(root: string, running = true) {
  for (const part of parts) save(path.join(root, 'live', `${part}.json`), oldSet[part]);
  const initial: Gates = {
    running: { 'app-fixture': running, 'app-worker': false }, ingress: running, sql: running, jobs: running, migration: false,
  };
  save(path.join(root, 'live', 'gates.json'), initial);
  save(path.join(root, 'original-gates.json'), initial);
  save(path.join(root, 'live', 'foreign.json'), foreignState);
}
async function temporary(work: (root: string) => Promise<void>, running = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-transaction-'));
  try { seed(root, running); await work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function journal(root: string) { return new AppUpdateJournalStore(path.join(root, 'journal')); }

class DurableProvider implements AppUpdateProvider {
  constructor(readonly root: string, readonly fault?: Fault) {}
  private fired = false;
  private hit(point: string, edge: Fault['edge']) {
    if (this.fired || this.fault?.point !== point || this.fault.edge !== edge) return;
    this.fired = true;
    if (this.fault.action === 'kill') process.kill(process.pid, 'SIGKILL');
    throw new Error(`injected ${point}:${edge}`);
  }
  private log(name: string) {
    const file = path.join(this.root, 'events.ndjson');
    appendFileSync(file, `${JSON.stringify({ name, state: state(this.root), gates: gates(this.root) })}\n`, { mode: 0o600 });
    const fd = openSync(file, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(this.root);
  }
  async effect(name: string, work: () => void | Promise<void>) {
    this.log(`${name}:before`);
    this.hit(name, 'before');
    await work();
    this.log(`${name}:after`);
    this.hit(name, 'after');
  }
  private directory(record: AppUpdateRecord) { return path.join(this.root, 'points', record.id); }
  point(record: AppUpdateRecord, part: Part) { return path.join(this.directory(record), `${part}.json`); }
  private plan(record: AppUpdateRecord) {
    return load<{ gates: Gates; digests: Record<Part, string> }>(path.join(this.directory(record), 'plan.json'));
  }
  async initialize(record: AppUpdateRecord) {
    await this.effect('initialize', () => {
      save(path.join(this.directory(record), 'plan.json'), {
        gates: gates(this.root), digests: Object.fromEntries(parts.map(p => [p, hash(state(this.root)[p])])),
      });
    });
  }
  private closeGates() {
    save(path.join(this.root, 'live', 'gates.json'), {
      running: { 'app-fixture': false, 'app-worker': false }, ingress: false, sql: false, jobs: false, migration: false,
    });
  }
  async quiesce(_record: AppUpdateRecord) { await this.effect('quiesce', () => this.closeGates()); }
  async checkpoint(record: AppUpdateRecord, resource: UpdateResource): Promise<UpdateCheckpoint> {
    const part = resourceParts.get(updateResourceKey(resource))!;
    await this.effect(`checkpoint:${part}`, () => {
      assert.deepEqual(gates(this.root).running, { 'app-fixture': false, 'app-worker': false });
      assert.equal(gates(this.root).sql || gates(this.root).jobs || gates(this.root).ingress, false);
      save(this.point(record, part), state(this.root)[part]);
    });
    const methods = {
      container: 'runtime-copy', volume: 'volume-snapshot', database: 'logical-postgres', metadata: 'scoped-metadata',
    } as const;
    return {
      resource: updateResourceKey(resource), method: methods[resource.kind as keyof typeof methods],
      reference: `${part}.json`, sha256: hash(load(this.point(record, part))), verifiedAt: new Date().toISOString(),
    };
  }
  private readPoint(record: AppUpdateRecord, part: Part): unknown {
    const value = load(this.point(record, part));
    assert.equal(hash(value), this.plan(record).digests[part], `corrupt checkpoint ${part}`);
    const receipt = record.checkpoints.find(c => resourceParts.get(c.resource) === part);
    if (receipt) {
      assert.equal(receipt.reference, `${part}.json`);
      assert.equal(receipt.sha256, hash(value));
    }
    return value;
  }
  async validateCheckpoints(record: AppUpdateRecord) {
    await this.effect('validate', () => { for (const part of parts) this.readPoint(record, part); });
  }
  async applying(_record: AppUpdateRecord) {
    await this.effect('migration-access', () => {
      assert.equal(gates(this.root).ingress || gates(this.root).sql || gates(this.root).jobs, false);
      save(path.join(this.root, 'live', 'gates.json'), { ...gates(this.root), migration: true });
    });
  }
  async restore(record: AppUpdateRecord) {
    await this.effect('restore', async () => {
      // Gate closure is idempotent; never reopen a partially restored state.
      if (!existsSync(path.join(this.directory(record), 'plan.json'))) return; // No provider effect before initialize.
      this.closeGates();
      const applying = existsSync(path.join(this.directory(record), 'applying.json'));
      // Validate the entire required set before restoring even one resource.
      if (applying) await this.validateCheckpoints(record);
      for (const part of parts) {
        if (!applying && !existsSync(this.point(record, part))) continue;
        const point = this.readPoint(record, part);
        await this.effect(`restore:${part}`, () => save(path.join(this.root, 'live', `${part}.json`), point));
      }
    });
  }
  async verifyRestored(record: AppUpdateRecord) {
    await this.effect('verify-restored', () => {
      if (!existsSync(path.join(this.directory(record), 'plan.json'))) return;
      for (const part of parts) assert.equal(hash(state(this.root)[part]), this.plan(record).digests[part]);
      assert.equal(gates(this.root).ingress || gates(this.root).sql || gates(this.root).jobs, false);
    });
  }
  async reopen(record: AppUpdateRecord) {
    await this.effect('reopen', () => {
      assert.ok(record.commit || record.rollbackVerifiedAt, 'a durable receipt must precede reopening');
      assert.deepEqual(state(this.root), record.commit ? newSet : oldSet, 'only a compatible whole set can reopen');
      const original = existsSync(path.join(this.directory(record), 'plan.json')) ? this.plan(record).gates : gates(this.root);
      assert.deepEqual(original.running, record.originalRunning);
      save(path.join(this.root, 'live', 'gates.json'), { ...original, running: record.originalRunning });
    });
  }
  async cleanup(record: AppUpdateRecord) {
    await this.effect('cleanup', () => {
      rmSync(this.directory(record), { recursive: true, force: true });
      syncDirectory(existsSync(path.join(this.root, 'points')) ? path.join(this.root, 'points') : this.root);
    });
  }
  async apply(transaction: AppUpdateTransaction) {
    const record = transaction.record();
    // This workload marker represents provider effects, independent of journal step names.
    save(path.join(this.directory(record), 'applying.json'), true);
    await transaction.mutate('before-hook', () => this.effect('hook', () => {
      save(path.join(this.root, 'live', 'volume.json'), {
        files: { 'user/document': 'converted content', 'cache/index': 'new format' },
      });
    }));
    await transaction.mutate('explicit-migration', () => this.effect('sql', () => {
      assert.equal(gates(this.root).migration, true);
      save(path.join(this.root, 'live', 'database.json'), {
        schema: ['id', 'body', 'format'], rows: [{ id: 1, body: 'converted content', format: 2 }],
        migrations: ['explicit-sql'],
      });
    }));
    await transaction.mutate('replace-code', () => this.effect('runtime', () => {
      for (const part of ['runtime', 'worker'] as const) save(path.join(this.root, 'live', `${part}.json`), newSet[part]);
    }));
    await transaction.mutate('first-start', () => this.effect('startup', () => {
      save(path.join(this.root, 'live', 'database.json'), newSet.database);
      save(path.join(this.root, 'live', 'volume.json'), newSet.volume);
      save(path.join(this.root, 'live', 'gates.json'), {
        ...gates(this.root), running: { 'app-fixture': true, 'app-worker': true },
      });
    }));
    transaction.verifying();
    await transaction.mutate('health-check', () => this.effect('health', () => {
      for (const part of parts.filter(p => p !== 'metadata')) assert.deepEqual(state(this.root)[part], newSet[part]);
      assert.equal(gates(this.root).ingress || gates(this.root).sql || gates(this.root).jobs, false);
    }));
    await transaction.mutate('publish-install', () => this.effect('metadata', () => {
      save(path.join(this.root, 'live', 'metadata.json'), newSet.metadata);
    }));
    return { value: 'updated', metadataDigest: hash(newSet.metadata) };
  }
}

async function execute(root: string, fault?: Fault) {
  const provider = new DurableProvider(root, fault);
  return runAppUpdateTransaction(journal(root), input(root), provider, tx => provider.apply(tx));
}
async function resume(root: string, fault?: Fault) {
  const store = journal(root);
  const [record] = store.list();
  const lease = store.resume(record.id);
  try { await new AppUpdateTransaction(lease, new DurableProvider(root, fault)).recover(); }
  finally { lease.release(); }
}
function assertHeld(root: string) {
  const store = journal(root);
  for (const resource of resources) assert.equal(store.isReserved(resource), true, resource.name);
  assert.throws(() => store.create(input(root)), /reserved/);
}
function assertTerminal(root: string, outcome: 'old' | 'new') {
  assert.deepEqual(state(root), outcome === 'old' ? oldSet : newSet);
  assert.deepEqual(gates(root), load(path.join(root, 'original-gates.json')));
  assert.deepEqual(load(path.join(root, 'live', 'foreign.json')), foreignState);
  const store = journal(root);
  const [record] = store.list();
  assert.equal(record.cleanupComplete, true);
  assert.equal(Boolean(record.commit), outcome === 'new');
  assert.equal(Boolean(record.rollbackVerifiedAt), outcome === 'old');
  assert.ok(record.steps.every(s => s.state === 'completed'));
  assert.deepEqual(readdirSync(path.join(root, 'journal', 'locks')), []);
  for (const resource of resources) assert.equal(store.isReserved(resource), false);
  assert.equal(existsSync(path.join(root, 'points', record.id)), false);
  for (const event of events(root).filter(e => e.name === 'reopen:after')) {
    assert.deepEqual(event.state, outcome === 'old' ? oldSet : newSet);
    assert.deepEqual(event.gates, load(path.join(root, 'original-gates.json')));
  }
  // A new operation is admitted only after durable terminal cleanup.
  const next = store.create(input(root));
  next.release();
}

const spec = fileURLToPath(import.meta.url);
const panel = path.resolve(path.dirname(spec), '..');
function child(root: string, mode: 'update' | 'recover', fault?: Fault, phase?: AppUpdatePhase | 'releasing') {
  return spawnSync(process.execPath, ['--import', 'tsx', spec], {
    cwd: panel, timeout: 15_000, encoding: 'utf8',
    env: { ...process.env, YOUEYE_TRANSACTION_CHILD: JSON.stringify({ root, mode, fault, phase }) },
  });
}

function killAfterDurablePhase(root: string, phase: AppUpdatePhase | 'releasing') {
  // Fail immediately after the journal directory is synchronized, before the
  // driver receives acknowledgement. Observe durable receipts, not source code.
  const filesystem = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const sync = filesystem.fsyncSync;
  filesystem.fsyncSync = fd => {
    sync(fd);
    const watched = path.join(root, 'journal', phase === 'releasing' ? 'locks' : 'operations');
    if (!existsSync(watched)) return;
    const descriptor = fs.fstatSync(fd);
    const directory = fs.lstatSync(watched);
    if (!descriptor.isDirectory() || descriptor.dev !== directory.dev || descriptor.ino !== directory.ino) return;
    if (phase === 'releasing') {
      const remaining = readdirSync(watched).length;
      if (remaining > 0 && remaining < resources.length) process.kill(process.pid, 'SIGKILL');
    } else {
      for (const name of readdirSync(watched).filter(s => s.endsWith('.json'))) {
        if (load<AppUpdateRecord>(path.join(watched, name)).phase === phase) process.kill(process.pid, 'SIGKILL');
      }
    }
  };
}

// Reuse this exact durable provider in child processes without creating helper files.
// Parent and recovery children share only filesystem bytes, never an in-memory store.
if (process.env.YOUEYE_TRANSACTION_CHILD) {
  const request = JSON.parse(process.env.YOUEYE_TRANSACTION_CHILD) as {
    root: string; mode: 'update' | 'recover'; fault?: Fault; phase?: AppUpdatePhase | 'releasing';
  };
  if (request.phase) killAfterDurablePhase(request.root, request.phase);
  const work = request.mode === 'update' ? execute(request.root, request.fault) : resume(request.root, request.fault);
  work.catch(error => { console.error(error); process.exitCode = 1; });
} else {
  for (const running of [true, false]) {
    test(`success publishes the complete new set and preserves original running=${running}`, () => temporary(async root => {
      assert.equal(await execute(root), 'updated');
      assertTerminal(root, 'new');
      assert.equal(events(root).filter(e => e.name === 'startup:after').length, 1);
    }, running));
  }

  for (const phase of ['preflight', 'quiescing', 'checkpointing', 'prepared', 'applying', 'verifying', 'committed', 'cleanup', 'releasing'] as const) {
    test(`SIGKILL after durable ${phase} publication recovers according to commit evidence`, () => temporary(async root => {
      const killed = child(root, 'update', undefined, phase);
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const [record] = journal(root).list();
      if (phase !== 'releasing') assert.equal(record.phase, phase);
      assertHeld(root);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, record.commit ? 'new' : 'old');
    }));
  }

  for (const phase of ['recovering', 'rolled_back', 'recovery_required', 'cleanup', 'releasing'] as const) {
    test(`SIGKILL after durable rollback ${phase} publication keeps recovery resumable`, () => temporary(async root => {
      assert.equal(child(root, 'update', { point: 'startup', edge: 'after', action: 'kill' }).signal, 'SIGKILL');
      const failure: Fault | undefined = phase === 'recovery_required' ? { point: 'restore', edge: 'after' } : undefined;
      const killed = child(root, 'recover', failure, phase);
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      if (phase !== 'releasing') assert.equal(journal(root).list()[0].phase, phase);
      assertHeld(root);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'old');
    }));
  }

  const rollbackPoints = [
    'initialize', 'quiesce', ...parts.map(p => `checkpoint:${p}`), 'validate',
    'migration-access', 'hook', 'sql', 'runtime', 'startup', 'health', 'metadata',
  ];
  for (const point of rollbackPoints) for (const edge of ['before', 'after'] as const) {
    test(`${point}:${edge} failure restores code, files, schema, rows, install and gates`, () => temporary(async root => {
      await assert.rejects(execute(root, { point, edge }), new RegExp(`injected ${point}:${edge}`));
      assertTerminal(root, 'old');
    }));
  }

  for (const running of [true, false]) {
    test(`startup migration failure preserves original running=${running}`, () => temporary(async root => {
      await assert.rejects(execute(root, { point: 'startup', edge: 'after' }), /injected/);
      assertTerminal(root, 'old');
    }, running));
  }

  test('an apply callback cannot omit verification and still publish a commit', () => temporary(async root => {
    await assert.rejects(runAppUpdateTransaction(journal(root), input(root), new DurableProvider(root), async tx => {
      await tx.mutate('unverified-code', async () => save(path.join(root, 'live', 'runtime.json'), newSet.runtime));
      return { value: 'invalid', metadataDigest: hash(newSet.metadata) };
    }), /verification phase/);
    assertTerminal(root, 'old');
  }));

  test('an acknowledged effect cannot be replayed using the same mutation id', () => temporary(async root => {
    let invocations = 0;
    await assert.rejects(runAppUpdateTransaction(journal(root), input(root), new DurableProvider(root), async tx => {
      await tx.mutate('non-idempotent', async () => { invocations++; });
      await tx.mutate('non-idempotent', async () => { invocations++; });
      return { value: 'invalid', metadataDigest: hash(newSet.metadata) };
    }), /reconcile/);
    assert.equal(invocations, 1);
    assertTerminal(root, 'old');
  }));

  test('reserved PostgreSQL storage is excluded from rewind while logical schema and rows roll back', () => temporary(async root => {
    const rawVolume: UpdateResource = {
      kind: 'volume', scope: 'default', name: 'raw-pg-data', ownerAppId: 'fixture', mutable: false,
    };
    const request = input(root);
    request.resources.push(rawVolume);
    const rawFile = path.join(root, 'live', 'raw-pg.json');
    save(rawFile, { engine: 'postgres', wal: 1 });
    const provider = new class extends DurableProvider {
      async effect(name: string, work: () => void | Promise<void>) {
        await super.effect(name, async () => {
          await work();
          if (name === 'sql') save(rawFile, { engine: 'postgres', wal: 2 });
        });
      }
    }(root, { point: 'startup', edge: 'after' });
    await assert.rejects(runAppUpdateTransaction(journal(root), request, provider, tx => provider.apply(tx)), /injected/);
    const [record] = journal(root).list();
    assert.equal(record.checkpoints.some(c => c.resource === updateResourceKey(rawVolume)), false);
    assert.equal(record.checkpoints.length, parts.length);
    assert.deepEqual(load(rawFile), { engine: 'postgres', wal: 2 });
    assert.equal(journal(root).isReserved(rawVolume), false);
    assertTerminal(root, 'old');
  }));

  // before = intent persisted without effect; after = durable effect without acknowledgement.
  for (const point of rollbackPoints) for (const edge of ['before', 'after'] as const) {
    test(`SIGKILL ${point}:${edge}: a fresh process restores instead of replaying application effects`, () => temporary(async root => {
      const killed = child(root, 'update', { point, edge, action: 'kill' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const [receipt] = journal(root).list();
      assert.equal(receipt.commit, undefined);
      assert.ok(receipt.steps.some(step => step.state === 'intent'), 'external effect must have a durable unacknowledged intent');
      assertHeld(root);
      const before = events(root);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'old');
      for (const name of ['hook', 'sql', 'runtime', 'startup', 'health', 'metadata']) {
        assert.equal(events(root).filter(e => e.name === `${name}:after`).length,
          before.filter(e => e.name === `${name}:after`).length, `recovery replayed ${name}`);
      }
    }));
  }

  for (const part of parts) for (const damage of ['missing', 'corrupt'] as const) {
    test(`${damage} ${part} checkpoint retains recovery_required and all reservations`, () => temporary(async root => {
      const killed = child(root, 'update', { point: 'metadata', edge: 'after', action: 'kill' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const [record] = journal(root).list();
      const point = new DurableProvider(root).point(record, part);
      const original = readFileSync(point);
      if (damage === 'missing') rmSync(point);
      else save(point, { invalid: 'checkpoint' });
      const failed = child(root, 'recover');
      assert.equal(failed.status, 1, failed.stderr);
      const pending = journal(root).read(record.id);
      assert.equal(pending.phase, 'recovery_required');
      assert.equal(pending.rollbackVerifiedAt, undefined);
      assert.equal(pending.cleanupComplete, false);
      assert.deepEqual(state(root), newSet, 'validation failure must not partially restore');
      assert.equal(gates(root).ingress || gates(root).sql || gates(root).jobs, false);
      assert.equal(events(root).filter(e => e.name === 'reopen:after').length, 0);
      assertHeld(root);
      writeFileSync(point, original, { mode: 0o600 });
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'old');
    }));
  }

  test('a restore that silently leaves incompatible SQL data cannot earn rollback verification', () => temporary(async root => {
    assert.equal(child(root, 'update', { point: 'metadata', edge: 'after', action: 'kill' }).signal, 'SIGKILL');
    const store = journal(root);
    const [record] = store.list();
    const provider = new class extends DurableProvider {
      async restore(receipt: AppUpdateRecord) {
        await super.restore(receipt);
        save(path.join(root, 'live', 'database.json'), newSet.database);
      }
    }(root);
    const lease = store.resume(record.id);
    try { await assert.rejects(new AppUpdateTransaction(lease, provider).recover()); }
    finally { lease.release(); }
    assert.equal(journal(root).read(record.id).phase, 'recovery_required');
    assert.equal(journal(root).read(record.id).rollbackVerifiedAt, undefined);
    assert.deepEqual(state(root), { ...oldSet, database: newSet.database });
    assert.equal(gates(root).ingress || gates(root).sql || gates(root).jobs, false);
    assert.equal(events(root).some(e => e.name === 'reopen:after'), false);
    assertHeld(root);
    const recovered = child(root, 'recover');
    assert.equal(recovered.status, 0, recovered.stderr);
    assertTerminal(root, 'old');
  }));

  for (const point of ['restore', ...parts.map(p => `restore:${p}`), 'verify-restored']) {
    test(`${point} lost acknowledgement retains locks and permits idempotent restore retry`, () => temporary(async root => {
      assert.equal(child(root, 'update', { point: 'metadata', edge: 'after', action: 'kill' }).signal, 'SIGKILL');
      await assert.rejects(resume(root, { point, edge: 'after' }), /injected/);
      const [record] = journal(root).list();
      assert.equal(record.phase, 'recovery_required');
      assert.equal(record.rollbackVerifiedAt, undefined);
      assertHeld(root);
      assert.equal(gates(root).ingress || gates(root).sql || gates(root).jobs, false);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'old');
    }));
    test(`SIGKILL during ${point}: a second recovery process completes the old set`, () => temporary(async root => {
      assert.equal(child(root, 'update', { point: 'metadata', edge: 'after', action: 'kill' }).signal, 'SIGKILL');
      const killed = child(root, 'recover', { point, edge: 'after', action: 'kill' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      assertHeld(root);
      assert.equal(journal(root).list()[0].rollbackVerifiedAt, undefined);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'old');
    }));
  }

  for (const fenceFails of [false, true]) {
    test(`failed restored health refences writers and retains recovery evidence (fence failure ${fenceFails})`, () => temporary(async root => {
      class FailedHealthProvider extends DurableProvider {
        async verifyRestored(record: AppUpdateRecord) {
          await super.verifyRestored(record);
          save(path.join(root, 'live', 'gates.json'), {
            ...gates(root), running: record.originalRunning, sql: true, jobs: true,
          });
          throw new Error('restored health failed');
        }
        async fenceRecovery() {
          if (fenceFails) throw new Error('fence unavailable');
          save(path.join(root, 'live', 'gates.json'), {
            ...gates(root), running: { 'app-fixture': false, 'app-worker': false }, sql: false, jobs: false,
          });
        }
      }
      const provider = new FailedHealthProvider(root, { point: 'metadata', edge: 'after' });
      await assert.rejects(runAppUpdateTransaction(journal(root), input(root), provider, tx => provider.apply(tx)), /restored health failed/);
      const [record] = journal(root).list();
      assert.equal(record.phase, 'recovery_required');
      assert.equal(record.rollbackVerifiedAt, undefined);
      assert.equal(record.errorCode, fenceFails ? 'recovery-fence-unverified' : 'scoped-restore-unverified');
      assertHeld(root);
      if (!fenceFails) assert.equal(gates(root).sql || gates(root).jobs, false);
      assert.equal(existsSync(path.join(root, 'points', record.id)), true);
    }));
  }

  for (const point of ['reopen', 'cleanup']) for (const edge of ['before', 'after'] as const) {
    test(`committed ${point}:${edge} failure never rewinds and fresh recovery finishes cleanup`, () => temporary(async root => {
      await assert.rejects(execute(root, { point, edge }), /injected/);
      const [record] = journal(root).list();
      assert.equal(record.commit?.metadataAfterSHA256, hash(newSet.metadata));
      assert.equal(record.rollbackVerifiedAt, undefined);
      assert.equal(record.cleanupComplete, false);
      assert.deepEqual(state(root), newSet);
      assertHeld(root);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'new');
      assert.equal(events(root).some(e => e.name.startsWith('restore:')), false);
    }));
    test(`SIGKILL committed ${point}:${edge} preserves new set across process restart`, () => temporary(async root => {
      const killed = child(root, 'update', { point, edge, action: 'kill' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      assert.ok(journal(root).list()[0].commit);
      assertHeld(root);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'new');
      assert.equal(events(root).some(e => e.name.startsWith('restore:')), false);
    }));
  }

  for (const point of ['startup', 'cleanup']) {
    test(`restart after ${point} preserves a fully stopped original application`, () => temporary(async root => {
      const killed = child(root, 'update', { point, edge: 'after', action: 'kill' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      assertHeld(root);
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, point === 'cleanup' ? 'new' : 'old');
      assert.deepEqual(gates(root).running, { 'app-fixture': false, 'app-worker': false });
    }, false));
  }

  for (const point of ['reopen', 'cleanup']) for (const edge of ['before', 'after'] as const) {
    test(`verified rollback ${point}:${edge} failure resumes cleanup without restoring twice`, () => temporary(async root => {
      assert.equal(child(root, 'update', { point: 'startup', edge: 'after', action: 'kill' }).signal, 'SIGKILL');
      await assert.rejects(resume(root, { point, edge }), /injected/);
      const [record] = journal(root).list();
      assert.ok(record.rollbackVerifiedAt);
      assert.equal(record.commit, undefined);
      assertHeld(root);
      const restores = events(root).filter(e => e.name === 'restore:after').length;
      const recovered = child(root, 'recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      assertTerminal(root, 'old');
      assert.equal(events(root).filter(e => e.name === 'restore:after').length, restores);
    }));
  }
}
