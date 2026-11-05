import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicClientRegistration } from '../src/lib/identity/public-client';

test('native public clients accept HTTPS and loopback redirects', () => {
  assert.deepEqual(validatePublicClientRegistration({ name: 'Phone', redirectUris: [
    'https://app.example.test/callback', 'http://127.0.0.1:49152/callback', 'http://[::1]:49152/callback',
  ] }), { name: 'Phone', redirectUris: [
    'https://app.example.test/callback', 'http://127.0.0.1:49152/callback', 'http://[::1]:49152/callback',
  ] });
});

test('public client registration rejects unsafe and ambiguous redirects', () => {
  for (const uri of [
    'http://example.test/callback', 'http://localhost:49152/callback',
    'https://user@example.test/callback', 'https://example.test/callback#fragment',
    'https://example.test:443/callback', 'javascript:alert(1)',
    'https://127.0.0.1/callback',
  ]) assert.equal(validatePublicClientRegistration({ name: 'Phone', redirectUris: [uri] }), null, uri);
  assert.equal(validatePublicClientRegistration({ name: 'Phone', redirectUris: ['https://app.example.test/cb', 'https://app.example.test/cb'] }), null);
});
