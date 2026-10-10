import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSetupRestoreStatus, type SetupRestoreStatus } from '../src/components/setup/restore-status';

test('routing interruption and a missing early status cannot replay restore or imply success', async () => {
  let reads = 0, pauses = 0;
  const status = await waitForSetupRestoreStatus('fixture', { attempts: 5,
    read: async () => {
      reads++;
      if (reads === 1) throw new TypeError('connection interrupted');
      if (reads === 2) return null;
      return { status: reads === 3 ? 'running' : 'completed', message: 'Restoring' };
    }, pause: async () => { pauses++; } });
  assert.equal(status.status, 'completed'); assert.equal(reads, 4); assert.equal(pauses, 3);
});

test('server failure remains failed and unavailable status stays uncertain at a finite bound', async () => {
  const failed: SetupRestoreStatus = { status: 'failed', message: 'Restore failed' };
  assert.deepEqual(await waitForSetupRestoreStatus('fixture', { read: async () => failed }), failed);
  let reads = 0;
  await assert.rejects(waitForSetupRestoreStatus('fixture', { attempts: 3,
    read: async () => { reads++; return null; }, pause: async () => {} }), /before starting another/);
  assert.equal(reads, 3);
});
