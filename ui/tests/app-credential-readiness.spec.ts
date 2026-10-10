import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCredentialBridge, handleAppCredentialReadiness } from '../src/lib/auth/app-credential-readiness';
import { AppCredentialPublicationConflict } from '../src/lib/auth/app-credential-publication';

const receipt = { installationId: '12345678-1234-4234-8234-123456789abc', generation: 1, revision: 2 };
const request = (body: unknown, headers: HeadersInit = { 'x-ui-bridge-token': 'fixture-bridge' }) =>
  new Request('http://fixture/ready', { method: 'POST', headers, body: JSON.stringify(body) });
const authorize = (r: Request) => authorizeCredentialBridge(r, 'fixture-bridge');

test('readiness needs bridge authority; unicode and mixed app authority fail without throwing', async () => {
  for (const headers of [
    {}, { cookie: 'admin=fixture' }, { authorization: 'Bearer fixture' },
    { 'x-ui-bridge-token': 'é'.repeat(14) },
    { 'x-ui-bridge-token': 'fixture-bridge', authorization: 'Bearer fixture' },
    { 'x-ui-bridge-token': 'fixture-bridge', 'x-youeye-user': 'someone' },
    { 'x-ui-bridge-token': 'fixture-bridge', 'x-youeye-app': 'wiki' },
    { 'x-ui-bridge-token': 'fixture-bridge', 'x-app-slug': 'wiki' },
  ]) {
    let called = false;
    const response = await handleAppCredentialReadiness(
      request(receipt, headers as Record<string, string>), 'wiki', authorize,
      async () => { called = true; },
    );
    assert.equal(response.status, 401);
    assert.equal(called, false);
  }
});

test('readiness validates exact non-secret receipt before mutation', async () => {
  for (const body of [
    null, [], {}, { ...receipt, token: 'fixture' }, { ...receipt, installationId: 'other' },
    { ...receipt, generation: 0 }, { ...receipt, revision: -1 },
    { ...receipt, revision: 1.5 }, { ...receipt, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, ready: 'false' }, { ...receipt, ready: null },
  ]) {
    const response = await handleAppCredentialReadiness(request(body), 'wiki', authorize,
      async () => { assert.fail('Invalid receipt must not mutate'); });
    assert.equal(response.status, 400);
  }
  assert.equal((await handleAppCredentialReadiness(request(receipt), '../wiki', authorize, async () => {})).status, 400);
});

test('authenticated readiness suspension passes the exact false flag without changing generation', async () => {
  let actual;
  const response = await handleAppCredentialReadiness(request({ ...receipt, ready: false }), 'wiki', authorize,
    async (_app, value) => { actual = value; });
  assert.equal(response.status, 200);
  assert.deepEqual(actual, { ...receipt, ready: false });
});

test('readiness binds generation and separates conflict from unavailable verifier', async () => {
  let calls = 0;
  const response = await handleAppCredentialReadiness(request(receipt), 'wiki', authorize, async (appId, actual) => {
    assert.equal(appId, 'wiki');
    assert.deepEqual(actual, receipt);
    calls++;
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  for (const [error, status] of [
    [new AppCredentialPublicationConflict(), 409],
    [new Error('private database fixture'), 503],
  ] as const) {
    const denied = await handleAppCredentialReadiness(request(receipt), 'wiki', authorize, async () => { throw error; });
    assert.equal(denied.status, status);
    assert.ok(!(await denied.text()).includes('private database fixture'));
  }
});
