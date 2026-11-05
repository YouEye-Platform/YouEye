import assert from 'node:assert/strict';
import test from 'node:test';
import { runPairedPointerBackup } from '../src/lib/pointer/paired-backup-operation';

function fixture(original = 'Running') {
  let state = original;
  const events: string[] = [];
  return { events, runtime: {
    state: async () => state,
    stop: async () => { events.push('stop'); state = 'Stopped'; },
    start: async () => { events.push('start'); state = 'Running'; },
    waitRunning: async () => { assert.equal(state, 'Running'); events.push('ready'); },
    maintenance: () => ({ markFailed: () => { events.push('failed'); }, release: () => { events.push('released'); } }),
  } };
}

test('paired Pointer backup stops writers through SQL and file capture, restoring prior running intent', async () => {
  const {runtime, events} = fixture();
  assert.equal(await runPairedPointerBackup(async () => {
    assert.equal(await runtime.state(), 'Stopped'); events.push('sql');
    await Promise.resolve(); assert.equal(await runtime.state(), 'Stopped'); events.push('files'); return 'encrypted';
  }, runtime), 'encrypted');
  assert.deepEqual(events, ['stop', 'sql', 'files', 'start', 'ready', 'released']);
});

test('paired Pointer backup preserves stopped intent and restarts after capture failure', async () => {
  const absent = fixture('Absent');
  assert.equal(await runPairedPointerBackup(async () => 'pre-AI backup', absent.runtime), 'pre-AI backup');
  assert.deepEqual(absent.events, []);
  const stopped = fixture('Stopped');
  await runPairedPointerBackup(async () => {}, stopped.runtime);
  assert.deepEqual(stopped.events, ['released']);
  const running = fixture();
  await assert.rejects(runPairedPointerBackup(async () => { throw new Error('capture failed'); }, running.runtime), /capture failed/);
  assert.deepEqual(running.events, ['stop', 'start', 'ready', 'released']);
});

test('paired Pointer backup refuses unknown state and retains maintenance after failed restart', async () => {
  const unknown = fixture('Unknown');
  await assert.rejects(runPairedPointerBackup(async () => { throw new Error('must not capture'); }, unknown.runtime), /identity is unavailable/);
  assert.deepEqual(unknown.events, []);
  const failed = fixture();
  failed.runtime.start = async () => { throw new Error('start failed'); };
  await assert.rejects(runPairedPointerBackup(async () => {}, failed.runtime), /requires reconciliation/);
  assert.deepEqual(failed.events, ['stop', 'failed']);
});
