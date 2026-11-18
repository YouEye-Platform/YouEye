import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedHandoffBrowserOrigin } from '../src/lib/identity/handoff-origin';

const identityOrigin = 'https://id.plan3appliance.test';

test('identity handoff accepts its own origin and the local setup surface over HTTPS or HTTP', () => {
  assert.equal(isTrustedHandoffBrowserOrigin(null, identityOrigin), true);
  assert.equal(isTrustedHandoffBrowserOrigin(identityOrigin, identityOrigin), true);
  for (const origin of [
    'https://192.168.31.37', 'http://192.168.31.37',
    'https://youeye.local', 'http://youeye.local', 'http://youeye-2.local',
  ]) {
    assert.equal(isTrustedHandoffBrowserOrigin(origin, identityOrigin), true, origin);
  }
});

test('identity handoff rejects arbitrary, raw-port, other .local names and malformed origins', () => {
  for (const origin of [
    'https://attacker.example',
    'http://attacker.example',
    'http://id.plan3appliance.test',
    'https://192.168.31.37:443',
    'http://192.168.31.37:80',
    'https://192.168.31.37:3000',
    'http://youeye.local:3000',
    'http://a.b.local',
    'http://foo.local',
    'https://mybox.local',
    'http://youeye-12345.local',
    'ftp://192.168.31.37',
    'https://192.168.31.37/path',
    'https://id.plan3appliance.test, https://attacker.example',
    'not an origin',
  ]) {
    assert.equal(isTrustedHandoffBrowserOrigin(origin, identityOrigin), false, origin);
  }
});
