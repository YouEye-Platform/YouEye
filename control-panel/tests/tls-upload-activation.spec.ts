import assert from 'node:assert/strict';
import test from 'node:test';
import { applyUploadedCertificateWithRecovery } from '../src/lib/acme/upload-activation';

test('activation follows persistence; either failure reapplies both previous states', async () => {
  for (const failure of ['none', 'persist', 'activate', 'restoreProxy', 'restoreStorage']) {
    const events: string[] = [];
    const action = (name: string) => async () => {
      events.push(name);
      if (failure === name || (failure.startsWith('restore') && name === 'activate')) throw new Error('synthetic failure');
    };
    const result = await applyUploadedCertificateWithRecovery({
      persist: action('persist'), activate: action('activate'),
      restoreProxy: action('restoreProxy'), restoreStorage: action('restoreStorage'),
    });
    if (failure === 'none') {
      assert.deepEqual(result, { ok: true }); assert.deepEqual(events, ['persist', 'activate']);
    } else {
      assert.deepEqual(result, { ok: false, recovered: !failure.startsWith('restore') });
      assert.deepEqual(events, failure === 'persist' ? ['persist', 'restoreProxy', 'restoreStorage']
        : ['persist', 'activate', 'restoreProxy', 'restoreStorage']);
    }
  }
});
