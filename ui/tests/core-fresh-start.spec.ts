import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coreSchemaStatus, runFreshCoreSchemaOnce } from '../src/lib/core-schema';

const marker = { schema: 'youeye.core-component.v1', role: 'ui', requestId: `install-${'a'.repeat(64)}`, manifestSHA256: 'a'.repeat(64), artifactSHA256: 'b'.repeat(64) };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'core-fresh-ui-'));
  const paths = { component: join(root, 'component.json'), receipts: join(root, 'receipts') };
  await writeFile(paths.component, JSON.stringify(marker), { mode: 0o600 });
  return { root, paths };
}

test('fresh UI becomes schema-complete before readiness and restarts do not replay it', async () => {
  const { root, paths } = await fixture();
  try {
    let effects = 0;
    assert.equal((await coreSchemaStatus('ui', paths)).state, 'pending');
    const initialize = async () => { effects++; assert.equal((await coreSchemaStatus('ui', paths)).state, 'started'); };
    assert.equal(await runFreshCoreSchemaOnce(initialize, paths), true);
    assert.equal((await coreSchemaStatus('ui', paths)).state, 'completed');
    assert.equal(await runFreshCoreSchemaOnce(initialize, paths), true);
    assert.equal(effects, 1);
    // A restart after the attempt completed never asks the database: after a reboot Postgres may answer later
    // than this process starts, and a failed probe would fail the start-up hook for good.
    const unreachable = async () => { throw Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }); };
    assert.equal(await runFreshCoreSchemaOnce(initialize, paths, unreachable), true);
    assert.equal(effects, 1);
  } finally { await rm(root, { recursive: true }); }
});

test('a first start waits for a database that answers a little later, and only for that', async () => {
  const { waitForDatabase, isDatabaseUnreachable } = await import('../src/lib/database-wait');
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  let clock = 0, calls = 0;
  const timing = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, deadlineMs: 10_000, pauseMs: 2_000 };
  await waitForDatabase(async () => { calls += 1; if (calls < 4) throw refused(); }, timing);
  assert.equal(calls, 4);
  assert.equal(clock, 6_000);
  // Still unreachable at the deadline: the last failure is thrown, and it is recognisable.
  clock = 0; calls = 0;
  await assert.rejects(waitForDatabase(async () => { calls += 1; throw refused(); }, timing), (error) => isDatabaseUnreachable(error));
  assert.equal(calls, 6);
  // Any other failure is not waited on.
  calls = 0;
  await assert.rejects(waitForDatabase(async () => { calls += 1; throw new Error('password authentication failed'); }, timing), /password/);
  assert.equal(calls, 1);
  // Forms the errors take: a dual-stack connect (AggregateError), a wrapped cause, Postgres still starting.
  assert.equal(isDatabaseUnreachable(new AggregateError([refused()], 'all attempts failed')), true);
  assert.equal(isDatabaseUnreachable(new Error('hook failed', { cause: Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }) })), true);
  assert.equal(isDatabaseUnreachable(Object.assign(new Error('the database system is starting up'), { code: '57P03' })), true);
  assert.equal(isDatabaseUnreachable(new Error('Core schema attempt is running or uncertain; native recovery required')), false);
  assert.equal(isDatabaseUnreachable(null), false);
});

test('fresh startup rejects running and uncertain migration without replay', async () => {
  const { root, paths } = await fixture();
  try {
    let effects = 0;
    let entered!: () => void, settle!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const hold = new Promise<void>(r => { settle = r; });
    const first = runFreshCoreSchemaOnce(async () => { effects++; entered(); await hold; throw Error('fixture failure'); }, paths);
    const rejected = assert.rejects(first, /uncertain/);
    await started;
    await assert.rejects(runFreshCoreSchemaOnce(async () => { effects++; }, paths), /running or uncertain/);
    settle(); await rejected;
    await assert.rejects(runFreshCoreSchemaOnce(async () => { effects++; }, paths), /running or uncertain/);
    assert.equal(effects, 1);
  } finally { await rm(root, { recursive: true }); }
});

test('build-independent fresh guard leaves unmanaged and update/recovery schema ownership intact', async () => {
  const { root, paths } = await fixture();
  try {
    const denied = async () => { assert.fail('non-fresh marker started database work'); };
    for (const requestId of ['update-1', 'recovery-1', `install-${'c'.repeat(64)}`]) {
      await writeFile(paths.component, JSON.stringify({ ...marker, requestId }), { mode: 0o600 });
      assert.equal(await runFreshCoreSchemaOnce(denied, paths, denied), false);
    }
    await rm(paths.component);
    assert.equal(await runFreshCoreSchemaOnce(denied, paths, denied), false);
    assert.deepEqual(await readdir(root), []);
    await writeFile(join(root, 'core-artifact-sha256'), marker.artifactSHA256, { mode: 0o600 });
    await assert.rejects(runFreshCoreSchemaOnce(denied, paths), /marker is missing/);
  } finally { await rm(root, { recursive: true }); }
});

test('preflight failure is effect-free and a changed or unsafe identity cannot initialize', async () => {
  const { root, paths } = await fixture();
  try {
    const denied = async () => { assert.fail('invalid identity initialized'); };
    await assert.rejects(runFreshCoreSchemaOnce(denied, paths, async () => { throw Error('database unavailable'); }), /database unavailable/);
    assert.equal((await coreSchemaStatus('ui', paths)).state, 'pending');
    await assert.rejects(runFreshCoreSchemaOnce(denied, paths, async () => {
      await writeFile(paths.component, JSON.stringify({ ...marker, requestId: 'update-new' }), { mode: 0o600 });
    }), /changed before initialization/);
    await writeFile(paths.component, JSON.stringify(marker), { mode: 0o600 });
    await chmod(paths.component, 0o666);
    await assert.rejects(runFreshCoreSchemaOnce(denied, paths), /identity unavailable/);
    assert.deepEqual((await readdir(root)).sort(), ['component.json']);
  } finally { await rm(root, { recursive: true }); }
});
