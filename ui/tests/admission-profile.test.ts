import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProfileBinding } from '../../shared/profile-binding';
import { readAdmissionBackup, validateResourceRestore } from '../../shared/admission-backup';
import type { AdmissionBackup } from '../../shared/admission-backup';
import type { ResourceOwnership } from '../../shared/admission';
const old = '10000000-0000-4000-8000-000000000001';
const fresh = '10000000-0000-4000-8000-000000000002';
const uiId = '20000000-0000-4000-8000-000000000001';
test('UUID binding preserves the same profile, refuses label adoption and retains deleted private IDs', () => {
  assert.deepEqual(decideProfileBinding(old, { id: uiId, identityId: old }, [], []), { reuseId: uiId, releaseLabelIds: [] });
  assert.throws(() => decideProfileBinding(fresh, null, [{ id: uiId, identityId: old }], []));
  assert.throws(() => decideProfileBinding(fresh, null, [{ id: uiId, identityId: null }], []));
  assert.throws(() => decideProfileBinding(old, { id: uiId, identityId: old }, [], [old]));
  const recreated = decideProfileBinding(fresh, null, [{ id: uiId, identityId: old }], [old]);
  assert.equal(recreated.reuseId, null);
  assert.deepEqual(recreated.releaseLabelIds, [uiId]);
});
test('restore preserves private UI bindings and explicit shared consumers across administration transfers', () => {
  const resource: ResourceOwnership = {
    schemaVersion: 1, appId: 'app-a', installationId: uiId, ownerId: old, resourceId: 'private',
    scope: 'per_user', enforcement: 'platform', identityUserId: old, uiUserId: fresh, shareId: null,
    consumerIds: [], state: 'active',
  };
  const backup: AdmissionBackup = {
    schemaVersion: 1, policy: { schemaVersion: 1, appId: 'app-a', installationId: uiId,
      ownerId: old, mode: 'owner', revision: 1, state: 'ready', publicAccess: false, userIds: [], groupIds: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    principals: [{ id: old, active: true, deleted: false, uiUserId: fresh, groupIds: [] }],
    groups: [], shares: [], resources: [resource],
  };
  readAdmissionBackup(backup, 'app-a');
  validateResourceRestore(backup, backup.principals, [resource], []);
  assert.throws(() => validateResourceRestore(backup,
    [{ ...backup.principals[0], uiUserId: uiId }], [resource], []));
  assert.throws(() => validateResourceRestore(backup,
    [{ ...backup.principals[0], deleted: true }], [resource], []));
  assert.throws(() => validateResourceRestore(backup, backup.principals, [{ ...resource, ownerId: fresh }], []));
  assert.throws(() => validateResourceRestore(backup, backup.principals, [{ ...resource, enforcement: 'app_native' }], []));
  const shared = { ...resource, resourceId: 'shared', scope: 'shared' as const,
    identityUserId: null, uiUserId: null, shareId: fresh, consumerIds: [uiId] };
  const share = { id: fresh, key: 'photos', ownerId: old, deleted: false, consumerIds: [uiId] };
  const sharedBackup = { ...backup, resources: [shared], shares: [share] };
  readAdmissionBackup(sharedBackup, 'app-a');
  validateResourceRestore(sharedBackup, backup.principals, [shared], [share]);
  assert.throws(() => validateResourceRestore(sharedBackup, backup.principals, [shared], [{ ...share, deleted: true }]));
  assert.throws(() => readAdmissionBackup({ ...sharedBackup, shares: [{ ...share, consumerIds: [] }] }, 'app-a'));
  assert.throws(() => readAdmissionBackup({ ...backup,
    principals: [...backup.principals, { ...backup.principals[0], id: fresh }] }, 'app-a'));
});
test('backup reader rejects unknown schemas, foreign installation ownership and duplicate identities', () => {
  const valid = {
    schemaVersion: 1, policy: { schemaVersion: 1, appId: 'app-a', installationId: uiId,
      ownerId: old, mode: 'owner', revision: 1, state: 'ready', publicAccess: false, userIds: [], groupIds: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    principals: [{ id: old, active: true, deleted: false, uiUserId: fresh, groupIds: [] }],
    groups: [], shares: [], resources: [],
  };
  assert.equal(readAdmissionBackup(valid, 'app-a').policy.ownerId, old);
  assert.throws(() => readAdmissionBackup({ ...valid, schemaVersion: 2 }, 'app-a'));
  assert.throws(() => readAdmissionBackup(valid, 'app-b'));
  assert.throws(() => readAdmissionBackup({ ...valid, principals: [...valid.principals, ...valid.principals] }, 'app-a'));
  assert.throws(() => readAdmissionBackup({ ...valid, resources: [{
    schemaVersion: 1, appId: 'app-a', installationId: fresh, ownerId: old, resourceId: 'config',
    scope: 'app_global', enforcement: 'needs_review', identityUserId: null, uiUserId: null, shareId: null,
    consumerIds: [], state: 'active',
  }] }, 'app-a'));
});
