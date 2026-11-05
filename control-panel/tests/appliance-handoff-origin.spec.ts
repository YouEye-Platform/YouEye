import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedHandoffBrowserOrigin } from '../src/lib/identity/handoff-origin';

const identityOrigin = 'https://id.plan3appliance.test';

test('identity handoff accepts its own origin and direct HTTPS appliance setup origins', () => {
  assert.equal(isTrustedHandoffBrowserOrigin(null, identityOrigin), true);
  assert.equal(isTrustedHandoffBrowserOrigin(identityOrigin, identityOrigin), true);
  assert.equal(isTrustedHandoffBrowserOrigin('https://192.168.31.37', identityOrigin), true);
});

test('identity handoff rejects arbitrary, insecure, raw-port, and malformed origins', () => {
  assert.equal(isTrustedHandoffBrowserOrigin('https://attacker.example', identityOrigin), false);
  assert.equal(isTrustedHandoffBrowserOrigin('http://192.168.31.37', identityOrigin), false);
  assert.equal(isTrustedHandoffBrowserOrigin('https://192.168.31.37:443', identityOrigin), false);
  assert.equal(isTrustedHandoffBrowserOrigin('https://192.168.31.37:3000', identityOrigin), false);
  assert.equal(isTrustedHandoffBrowserOrigin('https://192.168.31.37/path', identityOrigin), false);
  assert.equal(isTrustedHandoffBrowserOrigin('https://id.plan3appliance.test, https://attacker.example', identityOrigin), false);
  assert.equal(isTrustedHandoffBrowserOrigin('not an origin', identityOrigin), false);
});
