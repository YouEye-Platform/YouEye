import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAdmission, AdmissionLeaseStore, isResourceOwnership,
  type AdmissionPolicy, type AdmissionPrincipal, type AdmissionProjection,
} from '../../shared/admission';
import { AppManifestSchema } from '../src/lib/market/schema';

const owner = '10000000-0000-4000-8000-000000000001';
const allowed = '10000000-0000-4000-8000-000000000002';
const denied = '10000000-0000-4000-8000-000000000003';
const group = '20000000-0000-4000-8000-000000000001';
const otherGroup = '20000000-0000-4000-8000-000000000002';
const installation = '30000000-0000-4000-8000-000000000001';
const policy = (changes: Partial<AdmissionPolicy> = {}): AdmissionPolicy => ({
  schemaVersion: 1, appId: 'app-a', installationId: installation, ownerId: owner,
  mode: 'owner', userIds: [], groupIds: [], revision: 1, state: 'ready', publicAccess: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...changes,
});
const principal = (id: string, changes: Partial<AdmissionPrincipal> = {}): AdmissionPrincipal => ({
  id, active: true, deleted: false, groupIds: [], uiUserId: null, ...changes,
});
test('per-user manifest declaration requires UUID namespaces and cannot nominate owners or platform enforcement', () => {
  const declaration = AppManifestSchema.shape.data_ownership;
  assert.deepEqual(declaration.parse({ per_user: 'identity_uuid' }), { per_user: 'identity_uuid' });
  for (const value of [{ per_user: 'username' }, { per_user: true },
    { per_user: 'identity_uuid', ownerId: owner }, { per_user: 'identity_uuid', enforcement: 'platform' }]) {
    assert.equal(declaration.safeParse(value).success, false);
  }
});
test('all modes admit only active matching stable principals, with active owner inclusion', () => {
  for (const mode of ['owner', 'all_users', 'groups', 'users'] as const) {
    const p = policy({ mode, groupIds: [group], userIds: [allowed] });
    assert.equal(evaluateAdmission(p, principal(owner)).allowed, true, mode);
    assert.equal(evaluateAdmission(p, principal(allowed, { groupIds: [group] })).allowed, mode !== 'owner', mode);
    assert.equal(evaluateAdmission(p, principal(denied, { groupIds: [otherGroup] })).allowed, mode === 'all_users', mode);
    for (const id of [owner, allowed, denied]) {
      assert.equal(evaluateAdmission(p, principal(id, { active: false, groupIds: [group] })).allowed, false);
      assert.equal(evaluateAdmission(p, principal(id, { deleted: true, groupIds: [group] })).allowed, false);
    }
  }
});
test('empty selectors, recreated identities, removed group membership and other apps deny', () => {
  for (const mode of ['groups', 'users'] as const) {
    assert.equal(evaluateAdmission(policy({ mode }), principal(allowed)).allowed, false);
  }
  assert.equal(evaluateAdmission(policy({ mode: 'users', userIds: [allowed] }), principal(denied)).allowed, false);
  assert.equal(evaluateAdmission(policy({ mode: 'groups', groupIds: [group] }), principal(allowed)).allowed, false);
  assert.equal(evaluateAdmission(policy({ appId: 'app-b' }), principal(allowed)).allowed, false);
  // Admin flags and display labels cannot participate in admission.
  assert.equal(evaluateAdmission(policy(), { ...principal(denied), isAdmin: true, username: 'owner' }).allowed, false);
  assert.equal(evaluateAdmission(policy({ publicAccess: true }), principal(denied)).allowed, false);
});
test('unknown and hostile schema fails closed without enumerating policy selectors', () => {
  for (const p of [null, {}, policy({ schemaVersion: 2 as never }), policy({ revision: NaN }),
    policy({ revision: Number.MAX_SAFE_INTEGER + 1 }), policy({ ownerId: 'owner' }),
    policy({ groupIds: ['admin'] }), policy({ userIds: [allowed, allowed] }),
    policy({ state: 'unknown' as never }), policy({ mode: 'public' as never })]) {
    const decision = evaluateAdmission(p, principal(owner));
    assert.equal(decision.allowed, false);
    assert.deepEqual(Object.keys(decision).sort(), ['allowed', 'installationId', 'reason', 'revision']);
  }
  assert.equal(evaluateAdmission(policy(), null).reason, 'unknown_user');
  for (const state of ['pending', 'quarantined', 'retained', 'deleted'] as const) {
    assert.equal(evaluateAdmission(policy({ state }), principal(owner)).allowed, false);
  }
});
test('lease expiry, restart, clock changes, delayed delivery and app independence', () => {
  let wall = 10_000;
  let mono = 0;
  const leases = new AdmissionLeaseStore('boot-1', () => mono, () => wall);
  const projection = (changes: Partial<AdmissionProjection> = {}): AdmissionProjection => ({
    schemaVersion: 1, challenge: 'boot-1', policy: policy({ mode: 'users', userIds: [allowed] }),
    principals: [principal(owner), principal(allowed)], sequence: 1, issuedAt: 10_000, expiresAt: 70_000, ...changes,
  });
  assert.equal(leases.evaluate('app-a', owner).allowed, false);
  assert.equal(leases.apply(projection()), true);
  assert.equal(leases.evaluate('app-a', allowed).allowed, true);
  assert.equal(leases.apply(projection()), false, 'duplicate cannot renew');
  assert.equal(leases.apply(projection({ sequence: 2, expiresAt: 70_001 })), false, 'overlong lease');
  assert.equal(leases.apply(projection({ challenge: 'old-boot', sequence: 2 })), false);
  assert.equal(leases.apply(projection({ policy: policy({ appId: 'app-b' }) })), true);
  assert.equal(leases.apply(projection({ sequence: 2, policy: policy({ revision: 2 }) })), true);
  assert.equal(leases.evaluate('app-a', allowed).allowed, false, 'revocation applied');
  assert.equal(leases.evaluate('app-b', owner).allowed, true, 'unaffected app independent');
  assert.equal(leases.apply(projection({ sequence: 3 })), false, 'older revision cannot renew');
  wall -= 5_000;
  mono = 60_000;
  assert.equal(leases.evaluate('app-b', owner).allowed, false, 'backwards wall clock cannot extend lease');
  const restarted = new AdmissionLeaseStore('boot-2', () => mono, () => wall);
  assert.equal(restarted.apply(projection()), false);
  assert.equal(restarted.evaluate('app-a', owner).allowed, false);
});
test('tombstones and payload aliasing cannot resurrect deleted principals', () => {
  const leases = new AdmissionLeaseStore('boot', () => 0, () => 1);
  const p: AdmissionProjection = {
    schemaVersion: 1, challenge: 'boot', policy: policy({ mode: 'all_users' }),
    principals: [principal(allowed, { deleted: true })], sequence: 2, issuedAt: 1, expiresAt: 100,
  };
  assert.equal(leases.apply(p), true);
  p.principals[0].deleted = false;
  assert.equal(leases.evaluate('app-a', allowed).allowed, false);
  assert.equal(leases.apply({ ...p, sequence: 1 }), false);
  assert.equal(leases.apply({ ...p, sequence: 3, principals: [principal(allowed), principal(allowed)] }), false);
});
test('resource declarations require stable private and shared ownership', () => {
  const resource = {
    schemaVersion: 1, appId: 'app-a', installationId: installation, resourceId: 'config',
    scope: 'app_global', enforcement: 'needs_review', ownerId: owner,
    identityUserId: null, uiUserId: null, shareId: null, consumerIds: [], state: 'active',
  };
  assert.equal(isResourceOwnership(resource), true);
  assert.equal(isResourceOwnership({ ...resource, scope: 'per_user' }), false);
  assert.equal(isResourceOwnership({ ...resource, scope: 'per_user', identityUserId: allowed, enforcement: 'platform' }), false);
  assert.equal(isResourceOwnership({ ...resource, scope: 'per_user', identityUserId: allowed, enforcement: 'app_native' }), false);
  assert.equal(isResourceOwnership({ ...resource, scope: 'per_user', ownerId: allowed, identityUserId: allowed, enforcement: 'app_native' }), true);
  assert.equal(isResourceOwnership({ ...resource, scope: 'shared', shareId: group, consumerIds: [allowed] }), true);
  assert.equal(isResourceOwnership({ ...resource, scope: 'shared', shareId: 'household' }), false);
  assert.equal(isResourceOwnership({ ...resource, resourceId: '../../foreign' }), false);
});
