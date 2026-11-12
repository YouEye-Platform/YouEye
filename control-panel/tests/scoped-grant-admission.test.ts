import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopedGrantHandlers } from '../src/lib/caddy/scoped-grant-admission';
import type { CaddyRoute } from '../src/lib/caddy/types';

function fixture(): CaddyRoute {
  return { '@id': 'app-grant-search-to-searxng', terminal: true,
    match: [{ host: ['searx.fixture.test'], path: ['/search*'], method: ['GET'],
      ...{ header: { 'X-Youeye-App-Token': ['fixture-exact-service-token'] } } }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.2:8080' }] }] };
}
test('browser admission contamination is removed without changing machine scope or upstream', () => {
  const route = fixture(), original = structuredClone(route);
  route.handle.unshift({ handler: 'headers', request: { delete: ['X-YouEye-User'] } },
    { handler: 'reverse_proxy', rewrite: { uri: '/forward-auth/caddy' }, upstreams: [] });
  assert.deepEqual(scopedGrantHandlers(route), original.handle);
  assert.deepEqual(route.match, original.match);
  assert.deepEqual(scopedGrantHandlers(original), original.handle);
});
test('ordinary browser and deny routes are never exempted', () => {
  for (const id of ['app-search-main', 'app-grant-token-deny', 'ordinary']) {
    const route = fixture(); route['@id'] = id;
    assert.equal(scopedGrantHandlers(route), null);
  }
});
test('a grant ID alone cannot bypass browser admission', () => {
  for (const mutate of [
    (r: CaddyRoute) => { r.match = [{ host: ['searx.fixture.test'] }]; },
    (r: CaddyRoute) => { r.terminal = false; },
    (r: CaddyRoute) => { r.handle.push({ handler: 'rewrite', uri: '/other' }); },
  ]) { const route = fixture(); mutate(route); assert.throws(() => scopedGrantHandlers(route)); }
});
