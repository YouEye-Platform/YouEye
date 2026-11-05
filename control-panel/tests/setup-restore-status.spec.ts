import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverableRestoreSelection, waitForSetupRestoreStatus, type SetupRestoreStatus } from '../src/components/setup/restore-status';

test('routing interruption and a missing early status cannot replay restore or imply success', async () => {
  let reads = 0, pauses = 0;
  const status = await waitForSetupRestoreStatus('fixture', { attempts: 5,
    read: async () => {
      reads++;
      if (reads === 1) throw new TypeError('connection interrupted');
      if (reads === 2) return null;
      return { operationId: 'fixture', status: reads === 3 ? 'running' : 'completed', message: 'Restoring' };
    }, pause: async () => { pauses++; } });
  assert.equal(status.status, 'completed'); assert.equal(reads, 4); assert.equal(pauses, 3);
});

test('resume requires the exact inactive operation and complete bound selection', () => {
  const receipt: SetupRestoreStatus = { status: 'failed', message: 'paused', operationId: 'original',
    active: false, recovery: 'resume', mediaId: 'original-drive', backupId: 'backup-20261029T120000Z-1234abcd', appIds: ['notes'] };
  assert.deepEqual(recoverableRestoreSelection(receipt, 'original'),
    { mediaId: receipt.mediaId, backupId: receipt.backupId, appIds: ['notes'] });
  for (const change of [
    { operationId: 'foreign' }, { active: true }, { recovery: 'operator-required' as const },
    { recovery: undefined }, { appIds: ['notes', 'notes'] }, { appIds: ['../other'] }, { backupId: 'other' },
  ]) assert.equal(recoverableRestoreSelection({ ...receipt, ...change }, 'original'), null);
  assert.equal(recoverableRestoreSelection({ status: 'failed', message: 'legacy' }, 'original'), null);
  assert.equal(recoverableRestoreSelection({ ...receipt, recovery: 'finalize' }, 'original')?.mediaId, 'original-drive');
});

test('server failure remains failed and unavailable status stays uncertain at a finite bound', async () => {
  const failed: SetupRestoreStatus = { operationId: 'fixture', status: 'failed', message: 'Restore failed' };
  assert.deepEqual(await waitForSetupRestoreStatus('fixture', { read: async () => failed }), failed);
  let reads = 0;
  await assert.rejects(waitForSetupRestoreStatus('fixture', { attempts: 3,
    read: async () => { reads++; return null; }, pause: async () => {} }), /before starting another/);
  assert.equal(reads, 3);
});

test('a foreign terminal receipt is uncertain and rejected admission can be checked once without waiting', async () => {
  let pauses = 0;
  await assert.rejects(waitForSetupRestoreStatus('original', {
    attempts: 1,
    read: async () => ({ operationId: 'foreign', status: 'completed', message: 'Other restore finished' }),
    pause: async () => { pauses++; },
  }), /before starting another/);
  assert.equal(pauses, 0);
});
