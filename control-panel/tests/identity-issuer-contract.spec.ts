import assert from 'node:assert/strict';
import test from 'node:test';
import { identityConfigFromSettings } from '../src/lib/identity/config';
import { getAppInternalIdentityBase } from '../src/lib/identity/issuer';

test('public issuer, browser endpoints and cookie scope follow a new URL and identity label', () => {
  const original = identityConfigFromSettings({ domain: 'first.test', subdomains: { identity: 'auth' } });
  const renamed = identityConfigFromSettings({ domain: 'next.test', subdomains: { identity: 'login' } });
  assert.equal(original.issuer, 'https://auth.first.test');
  assert.equal(renamed.issuer, 'https://login.next.test');
  assert.equal(renamed.externalUrl, renamed.issuer);
  assert.equal(renamed.cookieDomain, '.next.test');
  assert.equal(original.internalUrl, renamed.internalUrl);
  // Independent clone configuration cannot read a template database-origin pin.
  assert.deepEqual(renamed, identityConfigFromSettings({ domain: 'next.test', subdomains: { identity: 'login' } }));
  // Restore reinstates portable configuration, not a generated machine authority.
  assert.deepEqual(original, identityConfigFromSettings({ domain: 'first.test', subdomains: { identity: 'auth' } }));
});

test('isolated managed clients use the same logical authority on any bridge', () => {
  assert.equal(getAppInternalIdentityBase('youeye-app-notes'), 'http://id.youeye:3002');
  assert.equal(getAppInternalIdentityBase('youeye-app-search'), 'http://id.youeye:3002');
  assert.equal(getAppInternalIdentityBase('youeye-ui'), null);
});
