import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRestoredAdmission, readAppRestoreIntent } from '../src/lib/backup/app-restore-intent';
import type { AdmissionPolicy } from '../../shared/admission';

const policy: AdmissionPolicy = { schemaVersion: 1, appId: 'fixture',
  installationId: '20000000-0000-4000-8000-000000000001',
  ownerId: '10000000-0000-4000-8000-000000000001', mode: 'owner', userIds: [], groupIds: [],
  revision: 4, state: 'pending', publicAccess: false, createdAt: '', updatedAt: '' };
const metadata = { appId: policy.appId, installationId: policy.installationId,
  admissionOwnerId: policy.ownerId, enabled: false, desiredState: 'stopped' };

test('a stopped restore retains intent without changing its pending policy', () => {
  const before = structuredClone(policy);
  const result = readAppRestoreIntent(metadata, policy, policy);
  assert.equal(result.desiredState, 'stopped');
  assertRestoredAdmission(policy, result.admission);
  assert.deepEqual(policy, before);
  assert.equal(readAppRestoreIntent({ ...metadata, enabled: true, desiredState: 'running' }, policy, policy).desiredState, 'running');
  assert.equal(readAppRestoreIntent({ ...metadata, enabled: true }, policy, policy).desiredState, 'stopped');
});

test('recovery refuses missing, foreign, deleted, retained and quarantined installation authority', () => {
  const identity = readAppRestoreIntent(metadata, policy, policy).admission;
  for (const state of ['deleted', 'retained', 'quarantined'] as const)
    assert.throws(() => assertRestoredAdmission({ ...policy, state }, identity));
  assert.throws(() => assertRestoredAdmission(null, identity));
  assert.throws(() => assertRestoredAdmission(policy, { ...identity, ownerId: '10000000-0000-4000-8000-000000000002' }));
  assert.throws(() => assertRestoredAdmission(policy, { ...identity, installationId: '20000000-0000-4000-8000-000000000002' }));
  for (const change of [{ appId: 'foreign' }, { installationId: 'foreign' }, { admissionOwnerId: 'foreign' }])
    assert.throws(() => readAppRestoreIntent({ ...metadata, ...change }, policy, policy));
});

test('historical data restore retains a later administrator takeover without rewinding ownership', () => {
  const current = { ...policy, ownerId: '10000000-0000-4000-8000-000000000002', revision: 9 };
  assert.equal(readAppRestoreIntent(metadata, policy, current).admission.ownerId, current.ownerId);
  assert.throws(() => readAppRestoreIntent(metadata, policy, null));
  assert.throws(() => readAppRestoreIntent(metadata, policy, { ...current, installationId: '20000000-0000-4000-8000-000000000002' }));
});
