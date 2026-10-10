import assert from 'node:assert/strict';
import test from 'node:test';
import { runOwnedPostgresBackup } from '../src/lib/backup/owned-postgres-operation';

function fixture(original = 'Stopped') {
  let state = original;
  const events: string[] = [];
  return { events, setState: (value: string) => { state = value; }, runtime: {
    state: async () => state,
    start: async () => { events.push('start'); state = 'Running'; },
    ready: async () => { events.push('ready'); },
    stop: async () => { events.push('stop'); state = 'Stopped'; },
    maintenance: () => {
      events.push('maintenance');
      return { markFailed: () => { events.push('failed'); }, release: () => { events.push('released'); } };
    },
  } };
}

test('stopped own database becomes ready for logical capture and returns to Stopped before release', async () => {
  const f = fixture();
  const dump = await runOwnedPostgresBackup(async () => {
    assert.equal(await f.runtime.state(), 'Running'); f.events.push('dump'); return 'logical rows';
  }, f.runtime);
  assert.equal(dump, 'logical rows');
  assert.equal(await f.runtime.state(), 'Stopped');
  assert.deepEqual(f.events, ['maintenance', 'start', 'ready', 'dump', 'stop', 'released']);
});

test('running database retains its running intent on successful and failed dumps', async () => {
  const f = fixture('Running');
  assert.equal(await runOwnedPostgresBackup(async () => 'rows', f.runtime), 'rows');
  await assert.rejects(runOwnedPostgresBackup(async () => { throw Error('dump failed'); }, f.runtime), /dump failed/);
  assert.deepEqual(f.events, []); assert.equal(await f.runtime.state(), 'Running');
});

test('dump and readiness failures restore stopped intent without returning a successful backup', async () => {
  for (const failure of ['ready', 'dump']) {
    const f = fixture();
    if (failure === 'ready') f.runtime.ready = async () => { throw Error('ready failed'); };
    await assert.rejects(runOwnedPostgresBackup(async () => { throw Error('dump failed'); }, f.runtime), /failed/);
    assert.equal(await f.runtime.state(), 'Stopped');
    assert.deepEqual(f.events.slice(-2), ['stop', 'released']);
  }
});

test('partial start failure is reconciled to Stopped', async () => {
  const f = fixture();
  f.runtime.start = async () => { f.setState('Running'); throw Error('start response lost'); };
  await assert.rejects(runOwnedPostgresBackup(async () => { throw Error('must not dump'); }, f.runtime), /start response lost/);
  assert.equal(await f.runtime.state(), 'Stopped');
  assert.deepEqual(f.events, ['maintenance', 'stop', 'released']);
});

test('unknown initial state has no effects', async () => {
  const f = fixture('Unknown');
  await assert.rejects(runOwnedPostgresBackup(async () => 'must not dump', f.runtime), /identity is unavailable/);
  assert.deepEqual(f.events, []);
});

test('failed stop retains failed maintenance and denies backup completion', async () => {
  const f = fixture(); f.runtime.stop = async () => { throw Error('stop failed'); };
  await assert.rejects(runOwnedPostgresBackup(async () => 'rows', f.runtime), /requires reconciliation/);
  assert.equal(await f.runtime.state(), 'Running');
  assert.deepEqual(f.events, ['maintenance', 'start', 'ready', 'failed']);
});

test('a changed stopped intent before start never stops a competing runtime', async () => {
  const f = fixture();
  f.runtime.maintenance = () => { f.setState('Running'); return { markFailed: () => { f.events.push('failed'); }, release: () => { f.events.push('released'); } }; };
  await assert.rejects(runOwnedPostgresBackup(async () => 'must not dump', f.runtime), /requires reconciliation/);
  assert.deepEqual(f.events, ['failed']);
});
