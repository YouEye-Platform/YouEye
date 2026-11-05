import assert from 'node:assert/strict';
import test from 'node:test';
import { uiRuntimeHealth } from '../src/lib/runtime-health';

test('configured UI readiness includes successful database schema initialization', async () => {
  let initialized = false;
  assert.deepEqual(await uiRuntimeHealth(true, async () => { initialized = true; }), { status: 'ok', httpStatus: 200 });
  assert.equal(initialized, true);
});

test('configured UI with an unavailable database returns sanitized non-readiness', async () => {
  assert.deepEqual(await uiRuntimeHealth(true, async () => { throw new Error('private database detail'); }),
    { status: 'starting', httpStatus: 503 });
});

test('an unconfigured UI can boot for the initial setup wizard', async () => {
  assert.deepEqual(await uiRuntimeHealth(false, async () => assert.fail('Database is not configured')),
    { status: 'ok', httpStatus: 200 });
});
