import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInternetPermissions, collectInternetScopes, findInternetScope } from '../src/lib/internet/scopes';

// Every `proxy:` host is asked of each user and checked per user. The server-wide `scope: service` hosts were never
// asked for, so the gateway refused them; the field is gone (Plan 17 D3) and a stale one changes nothing.
test('every proxy host is a per-user grant', () => {
  const manifest = { internet: { proxy: [
    { host: 'api.example.org', paths: ['/v1/*'] },
    { host: 'other.example.org', paths: ['/x'], methods: ['post'], scope: 'service' },
  ] } };
  assert.deepEqual(collectInternetPermissions(manifest), ['internet:api.example.org', 'internet:other.example.org']);
  assert.deepEqual(collectInternetScopes(manifest)[1], { host: 'other.example.org', paths: ['/x'], methods: ['POST'] });
  assert.equal(findInternetScope(manifest, new URL('https://other.example.org/x'), 'POST')?.host, 'other.example.org');
});
