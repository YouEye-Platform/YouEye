import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  APP_SERVICE_CREDENTIAL_SCHEMA,
  checkAppCredentialTransition,
  isActiveAppCredential,
  parseAppBearer,
  parseAppCredentialProjection,
  type AppCredentialProjection,
} from '../../shared/app-service-credential';

function fixture(): AppCredentialProjection {
  return {
    schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId: 'wiki', installationId: randomUUID(),
    generation: 1, revision: 1, status: 'prepared',
    verifierHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    createdAt: '2026-10-07T00:00:00.000Z', rotatedAt: null, revokedAt: null, expiresAt: null,
  };
}

test('Bearer parser rejects missing, empty, bare, malformed and duplicate schemes', () => {
  for (const value of [
    null, '', 'fixture', 'Basic fixture', 'Bearer ', 'Bearer  fixture', 'Bearer\tfixture',
    'Bearer fixture, Bearer other', 'Bearer Bearer fixture', 'Bearer a b', 'Bearer fixture=',
  ]) {
    const headers = new Headers();
    if (value !== null) headers.set('authorization', value);
    assert.equal(parseAppBearer(headers), null);
  }
  const repeated = new Headers();
  repeated.append('authorization', 'Bearer fixture');
  repeated.append('authorization', 'Bearer other');
  assert.equal(parseAppBearer(repeated), null);
  assert.equal(parseAppBearer(new Headers({ authorization: 'Bearer fixture_v1-abc.def' })), 'fixture_v1-abc.def');
  assert.equal(parseAppBearer(new Headers({ authorization: 'bearer fixture' })), 'fixture');
});

test('wire parser rejects raw secrets, extra fields and invalid lifecycle metadata', () => {
  const prepared = fixture();
  assert.equal(parseAppCredentialProjection(prepared).appId, 'wiki');
  for (const input of [
    { ...prepared, secret: 'test-only' },
    { ...prepared, appId: '../wiki' },
    { ...prepared, generation: 0 },
    { ...prepared, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...prepared, verifierHash: '' },
    { ...prepared, installationId: 'not-an-installation' },
    { ...prepared, status: 'revoked' },
    { ...prepared, expiresAt: '2026-10-01T00:00:00.000Z' },
    { ...prepared, expiresAt: 'not-a-time' },
    { ...prepared, createdAt: '2026-10-07' },
  ]) assert.throws(() => parseAppCredentialProjection(input), /Invalid app credential projection/);
});

test('explicit expiry, prepared and revoked status all deny authentication', () => {
  const prepared = fixture();
  const now = Date.parse('2026-10-07T01:00:00.000Z');
  assert.equal(isActiveAppCredential(prepared, now), false);
  const active: AppCredentialProjection = { ...prepared, status: 'active', revision: 2 };
  assert.equal(isActiveAppCredential(active, now), true);
  assert.equal(isActiveAppCredential({ ...active, expiresAt: '2026-10-07T01:00:00.000Z' }, now), false);
  assert.equal(isActiveAppCredential({ ...active, expiresAt: '2026-10-07T02:00:00.000Z' }, now), true);
  assert.equal(isActiveAppCredential({ ...active, status: 'revoked', revokedAt: active.createdAt }, now), false);
  assert.equal(isActiveAppCredential({ ...active, expiresAt: 'invalid' }, now), false);
});

test('bridge transition is idempotent and rejects delayed, skipped and conflicting publication', () => {
  const prepared = fixture();
  assert.equal(checkAppCredentialTransition(null, prepared, 0), 'apply');
  assert.equal(checkAppCredentialTransition(prepared, { ...prepared }, 0), 'unchanged');
  const active: AppCredentialProjection = { ...prepared, revision: 2, status: 'active' };
  assert.equal(checkAppCredentialTransition(prepared, active, 1), 'apply');
  assert.equal(checkAppCredentialTransition(active, { ...active }, 1), 'unchanged');
  assert.throws(() => checkAppCredentialTransition(active, prepared, 0), /revision conflict/);
  assert.throws(() => checkAppCredentialTransition(prepared, { ...active, revision: 3 }, 1), /revision conflict/);
  assert.throws(() => checkAppCredentialTransition(null, active, 0), /revision conflict/);
  assert.throws(() => checkAppCredentialTransition(prepared, { ...active, verifierHash: fixture().verifierHash }, 1), /generation conflict/);
});

test('higher revision cannot resurrect a revoked generation or previously retired generation', () => {
  const prepared = fixture();
  const active: AppCredentialProjection = { ...prepared, revision: 2, status: 'active' };
  const revoked: AppCredentialProjection = { ...active, revision: 3, status: 'revoked', revokedAt: active.createdAt };
  assert.equal(checkAppCredentialTransition(active, revoked, 2), 'apply');
  assert.throws(() => checkAppCredentialTransition(revoked, { ...active, revision: 4 }, 3), /generation conflict/);
  const rotated: AppCredentialProjection = {
    ...active, revision: 3, generation: 2, status: 'prepared',
    verifierHash: fixture().verifierHash, rotatedAt: active.createdAt,
  };
  assert.equal(checkAppCredentialTransition(active, rotated, 2), 'apply');
  assert.throws(() => checkAppCredentialTransition(rotated, { ...active, revision: 4 }, 3), /generation conflict/);
  assert.throws(() => checkAppCredentialTransition(active, { ...rotated, generation: 3 }, 2), /generation conflict/);
});

test('reinstall requires a revoked predecessor and keeps revision ordering across installation identities', () => {
  const prepared = fixture();
  const active: AppCredentialProjection = { ...prepared, revision: 2, status: 'active' };
  const next = { ...fixture(), revision: 3 };
  assert.throws(() => checkAppCredentialTransition(active, next, 2), /reinstall requires revocation/);
  const revoked: AppCredentialProjection = { ...active, revision: 3, status: 'revoked', revokedAt: active.createdAt };
  assert.equal(checkAppCredentialTransition(revoked, { ...next, revision: 4 }, 3), 'apply');
});
