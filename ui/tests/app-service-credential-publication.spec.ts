import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  APP_SERVICE_CREDENTIAL_SCHEMA, checkAppCredentialRestoreFence, checkAppCredentialBatch, checkAppCredentialTransition, type AppCredentialProjection,
} from '../../shared/app-service-credential';
import {
  AppCredentialPublicationConflict, handleAppCredentialPublication, type AppCredentialPublisher,
} from '../src/lib/auth/app-credential-publication';
import { authorizeCredentialBridge } from '../src/lib/auth/app-credential-readiness';

function fixture() {
  const credential: AppCredentialProjection = {
    schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId: 'wiki', installationId: randomUUID(),
    generation: 1, revision: 1, status: 'prepared',
    verifierHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    createdAt: '2026-10-07T00:00:00.000Z', rotatedAt: null, revokedAt: null, expiresAt: null,
  };
  let current: AppCredentialProjection | null = null;
  let writes = 0;
  const publisher: AppCredentialPublisher = {
    authorizeBridge: request => authorizeCredentialBridge(request, 'bridge-fixture'),
    async publish(incoming, expectedRevision) {
      try {
        const result = checkAppCredentialTransition(current, incoming, expectedRevision);
        if (result === 'apply') { current = incoming; writes++; }
        return result;
      } catch { throw new AppCredentialPublicationConflict(); }
    },
    async publishBatch(incoming, expectedRevision) {
      try {
        const { result, credential: next } = checkAppCredentialBatch(current, incoming, expectedRevision);
        if (result === 'apply') { current = next; writes++; }
        return result;
      } catch { throw new AppCredentialPublicationConflict(); }
    },
  };
  function request(body: unknown = { credential, expectedRevision: 0 }, headers: HeadersInit = { 'x-ui-bridge-token': 'bridge-fixture' }) {
    return new Request('http://fixture/api/ui-bridge/app-credentials/wiki', {
      method: 'POST', body: JSON.stringify(body), headers,
    });
  }
  return { credential, publisher, request, writes: () => writes, current: () => current };
}

test('only authenticated bridge publication can mutate credentials', async () => {
  const { credential, publisher, request, writes } = fixture();
  const attempts: HeadersInit[] = [
    {},
    { authorization: 'Bearer app-fixture', 'x-youeye-app': 'wiki' },
    { cookie: 'ye-ui-session=admin-fixture' },
    { 'x-ui-bridge-token': 'wrong', cookie: 'ye-ui-session=admin-fixture' },
    { 'x-ui-bridge-token': 'bridge-fixture', authorization: 'Bearer app-fixture' },
    { 'x-ui-bridge-token': 'bridge-fixture', 'x-app-slug': 'wiki' },
  ];
  for (const headers of attempts) {
    const response = await handleAppCredentialPublication(request(undefined, headers), 'wiki', publisher);
    assert.equal(response.status, 401);
  }
  assert.equal(writes(), 0);
  const response = await handleAppCredentialPublication(request(), 'wiki', publisher);
  assert.equal(response.status, 200);
  assert.equal(writes(), 1);
  const body = await response.json();
  assert.equal(body.status, 'prepared');
  assert.ok(!('verifierHash' in body) && !('secret' in body));
  assert.ok(!JSON.stringify(body).includes(credential.verifierHash));
});

test('ordered batch publication applies atomically, suppresses retries and rejects skipped generations', async () => {
  const f = fixture();
  const active = { ...f.credential, status: 'active' as const, revision: 2 };
  const body = { credentials: [f.credential, active], expectedRevision: 0 };
  assert.equal((await handleAppCredentialPublication(f.request(body), 'wiki', f.publisher)).status, 200);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.current(), active);
  assert.equal((await handleAppCredentialPublication(f.request(body), 'wiki', f.publisher)).status, 200);
  assert.equal(f.writes(), 1);
  const skipped = { credentials: [f.credential, { ...active, revision: 4 }], expectedRevision: 0 };
  assert.equal((await handleAppCredentialPublication(f.request(skipped), 'wiki', f.publisher)).status, 409);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.current(), active);
});

test('publication retries suppress duplicate writes; stale deliveries cannot change active state', async () => {
  const { credential, publisher, request, writes, current } = fixture();
  assert.equal((await handleAppCredentialPublication(request(), 'wiki', publisher)).status, 200);
  const retry = await handleAppCredentialPublication(request(), 'wiki', publisher);
  assert.equal((await retry.json()).result, 'unchanged');
  assert.equal(writes(), 1);
  const active: AppCredentialProjection = { ...credential, revision: 2, status: 'active' };
  assert.equal((await handleAppCredentialPublication(request({ credential: active, expectedRevision: 1 }), 'wiki', publisher)).status, 200);
  assert.equal((await handleAppCredentialPublication(request(), 'wiki', publisher)).status, 409);
  assert.equal(current()?.status, 'active');
  assert.equal(writes(), 2);
});

test('malformed, mismatched, secret-bearing or unversioned bodies are rejected before persistence', async () => {
  const { credential, publisher, request, writes } = fixture();
  for (const body of [
    { credential, expectedRevision: -1 },
    { credential, expectedRevision: 0.5 },
    { credential, expectedRevision: 0, secret: 'secret-fixture' },
    { credential: { ...credential, secret: 'secret-fixture' }, expectedRevision: 0 },
    { credential: { ...credential, appId: 'notes' }, expectedRevision: 0 },
    { token_hash: credential.verifierHash },
    null,
  ]) {
    const response = await handleAppCredentialPublication(request(body), 'wiki', publisher);
    assert.equal(response.status, 400);
  }
  assert.equal(writes(), 0);
});

test('verifier persistence failure yields sanitized denial and cannot masquerade as readiness', async () => {
  const { publisher, request } = fixture();
  publisher.publish = async () => { throw new Error('fixture-private-detail'); };
  const response = await handleAppCredentialPublication(request(), 'wiki', publisher);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('fixture-private-detail'));
});

test('restore fence accepts equal fresh reads and lost ACKs without allowing activation or inconsistent CAS', () => {
  const active: AppCredentialProjection = { ...fixture().credential, status: 'active', revision: 2 };
  const fence: AppCredentialProjection = { ...active, status: 'revoked', revision: 3, revokedAt: '2026-10-07T01:00:00.000Z' };
  assert.equal(checkAppCredentialRestoreFence(active, fence, active), 'apply');
  assert.equal(checkAppCredentialRestoreFence(fence, fence, fence), 'unchanged');
  assert.equal(checkAppCredentialRestoreFence(fence, fence, active), 'unchanged');
  assert.throws(() => checkAppCredentialRestoreFence(null, fence, fence));
  assert.throws(() => checkAppCredentialRestoreFence(fence, { ...fence, status: 'active', revokedAt: null }, fence));
  assert.throws(() => checkAppCredentialRestoreFence(fence, fence, { ...fence, revision: 4 }));
  assert.throws(() => checkAppCredentialRestoreFence(fence, fence, { ...fence, installationId: randomUUID() }));
  assert.throws(() => checkAppCredentialRestoreFence(fence, fence, { ...fence, appId: 'notes' }));
  assert.throws(() => checkAppCredentialRestoreFence(fence, { ...fence, revision: 2 }, fence));
  assert.equal(fence.status, 'revoked');
  assert.equal(fence.revision, 3);
});
