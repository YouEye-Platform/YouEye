import test from 'node:test';
import assert from 'node:assert/strict';
import { readAdmissionBackup, validateResourceRestore } from '../../shared/admission-backup';
import type { AdmissionPolicy, AdmissionPrincipal, ResourceOwnership } from '../../shared/admission';

const owner = '10000000-0000-4000-8000-000000000001';
const deleted = '10000000-0000-4000-8000-000000000002';
const installationId = '20000000-0000-4000-8000-000000000001';
const principals: AdmissionPrincipal[] = [
  { id: owner, active: true, deleted: false, groupIds: [], uiUserId: null },
  { id: deleted, active: false, deleted: true, groupIds: [], uiUserId: null },
];
const policy: AdmissionPolicy = {
  schemaVersion: 1, appId: 'app-a', installationId, ownerId: owner, mode: 'owner',
  userIds: [], groupIds: [], revision: 5, state: 'ready', publicAccess: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const resource: ResourceOwnership = {
  schemaVersion: 1, appId: 'app-a', installationId, resourceId: `user-data:${deleted}`,
  scope: 'per_user', enforcement: 'app_native', ownerId: deleted, identityUserId: deleted,
  uiUserId: null, shareId: null, consumerIds: [], state: 'quarantined',
};
const backup = () => readAdmissionBackup({ schemaVersion: 1, policy, principals,
  groups: [], shares: [], resources: [resource] }, 'app-a');

test('coherent quarantined data restores under its exact tombstone without resurrecting a principal', () => {
  assert.doesNotThrow(() => validateResourceRestore(backup(), principals, [resource], []));
  assert.throws(() => validateResourceRestore(backup(), [principals[0]], [resource], []), /unknown or foreign/);
  assert.throws(() => validateResourceRestore({ ...backup(), resources: [{ ...resource, state: 'active' }] },
    principals, [resource], []), /unknown or foreign/);
  assert.throws(() => validateResourceRestore(backup(), principals, [{ ...resource, state: 'active' }], []));
  assert.throws(() => validateResourceRestore(backup(), principals, [{ ...resource, state: 'deleted' }], []));
  assert.throws(() => validateResourceRestore(backup(), principals, [{ ...resource, identityUserId: owner }], []));
});

test('ordinary restore cannot revive a resource removed after backup, even for a surviving owner', () => {
  const owned = { ...resource, ownerId: owner, identityUserId: owner, state: 'active' as const };
  const value = { ...backup(), resources: [owned] };
  assert.doesNotThrow(() => validateResourceRestore(value, principals, [owned], []));
  assert.throws(() => validateResourceRestore(value, principals, [{ ...owned, state: 'deleted' }], []));
  assert.throws(() => readAdmissionBackup({ ...value, schemaVersion: 2 }, 'app-a'));
  assert.throws(() => readAdmissionBackup({ ...backup(), principals: [principals[0]] }, 'app-a'),
    /principal, share or UI mapping/);
});
