import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { spineClient, SpineAPIError } from '../src/lib/spine/client';
import { assertIndependentCoreUpdate } from '../src/lib/updates/core-guard';

test('independent app updates do not depend on core receipt availability', async () => {
  const status = mock.method(spineClient, 'getCoreUpdateStatus', async () => { throw new Error('unavailable'); });
  try { await assertIndependentCoreUpdate('notes'); assert.equal(status.mock.callCount(), 0); }
  finally { status.mock.restore(); }
});

test('all component mutations fail closed on core ownership or unavailable evidence', async () => {
  for (const component of ['spine', 'control', 'ui', 'system', 'host-system']) {
    const status = mock.method(spineClient, 'getCoreUpdateStatus', async () => ({ schema: 'youeye.core-status.v1', managed: true }));
    try { await assert.rejects(assertIndependentCoreUpdate(component), /complete core selection/); }
    finally { status.mock.restore(); }
  }
  const status = mock.method(spineClient, 'getCoreUpdateStatus', async () => { throw new SpineAPIError('recovery', 409); });
  try { await assert.rejects(assertIndependentCoreUpdate('ui'), /recovery/); }
  finally { status.mock.restore(); }
});

test('observed legacy installation permits component updates', async () => {
  const status = mock.method(spineClient, 'getCoreUpdateStatus', async () => ({ schema: 'youeye.core-status.v1', managed: false }));
  try { await assertIndependentCoreUpdate('ui'); }
  finally { status.mock.restore(); }
});
