import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAppServiceUser, resolveBrowserSession } from '../src/lib/auth/service-request';

const user = {
  id: 'ui-user', identityId: 'identity-user', username: 'owner',
  name: 'Owner', email: 'fixture@example.invalid', isAdmin: true,
};
const serviceHeaders = () => new Headers({
  'x-youeye-app': 'wiki', 'x-youeye-user': 'identity-user',
  authorization: 'Bearer fixture',
});

test('explicit machine credentials and partial headers cannot acquire an admin cookie', async () => {
  for (const [key, value] of [
    ['authorization', 'Basic invalid'], ['authorization', 'Bearer invalid'],
    ['authorization', ''], ['x-youeye-app', 'wiki'], ['x-youeye-user', 'other'],
    ['x-ui-bridge-token', 'invalid'],
    ['x-app-slug', 'wiki'],
  ]) {
    let reads = 0;
    const session = await resolveBrowserSession(new Headers({ [key]: value }), async () => {
      reads++;
      return user;
    });
    assert.ok(session === null);
    assert.equal(reads, 0);
  }
  assert.equal(await resolveBrowserSession(new Headers(), async () => user), user);
});

test('app auth precedes user resolution; header aliases never cross canonical app identities', async () => {
  for (const claimedApp of ['notes', 'ye-wiki', 'app-wiki', 'Wiki', '']) {
    const headers = serviceHeaders();
    headers.set('x-youeye-app', claimedApp);
    let lookups = 0;
    assert.ok(await resolveAppServiceUser(headers, async () => ({ appId: 'wiki' }), async () => {
      lookups++;
      return user;
    }, () => true) === null);
    assert.equal(lookups, 0);
  }
  assert.ok(await resolveAppServiceUser(serviceHeaders(), async () => null, async () => user, () => true) === null);
});

test('legitimate service acting user carries canonical app and cannot become an admin', async () => {
  const result = await resolveAppServiceUser(serviceHeaders(), async () => ({ appId: 'wiki' }), async stableId => {
    assert.equal(stableId, user.identityId);
    return user;
  }, (appId, identityId) => {
    assert.equal(appId, "wiki"); assert.equal(identityId, user.identityId); return true;
  });
  assert.equal(result?.id, user.id);
  assert.equal(result?.appId, 'wiki');
  assert.equal(result?.isAdmin, false);
});

test('missing user, verifier failure and mixed bridge/service credentials deny', async () => {
  assert.ok(await resolveAppServiceUser(serviceHeaders(), async () => ({ appId: 'wiki' }), async () => null, () => true) === null);
  assert.ok(await resolveAppServiceUser(serviceHeaders(), async () => { throw new Error('private'); }, async () => user, () => true) === null);
  const headers = serviceHeaders();
  headers.set('x-ui-bridge-token', 'fixture');
  assert.ok(await resolveAppServiceUser(headers, async () => ({ appId: 'wiki' }), async () => user, () => true) === null);
});


test('valid app credentials require current stable Household admission', async () => {
  for (const active of [false, true]) {
    const denied = await resolveAppServiceUser(serviceHeaders(), async () => ({appId: 'wiki'}),
      async () => ({...user, identityId: active ? user.identityId : null}), () => false);
    assert.equal(denied, null);
  }
  assert.equal(await resolveAppServiceUser(serviceHeaders(), async () => ({appId: 'wiki'}),
    async () => user, () => {throw new Error('authority unavailable');}), null);
});
