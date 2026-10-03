import assert from 'node:assert/strict';
import test from 'node:test';
import { appIdentityDnsConfig } from '../src/lib/incus/app-network';
import { getAppInternalIdentityBase } from '../src/lib/identity/issuer';

test('existing app bridges acquire logical ID DNS without disturbing forwarding', () => {
  assert.equal(
    appIdentityDnsConfig('server=10.66.35.14', '10.76.0.1'),
    'server=10.66.35.14\naddress=/id.youeye/10.76.0.1',
  );
  assert.equal(
    appIdentityDnsConfig('server=10.66.35.14\naddress=/id.youeye/10.76.0.1', '10.76.0.1'),
    null,
  );
  assert.equal(
    appIdentityDnsConfig('server=10.66.35.14\naddress=/id.youeye/10.76.0.1', '10.76.0.33'),
    'server=10.66.35.14\naddress=/id.youeye/10.76.0.33',
  );
  assert.throws(() => appIdentityDnsConfig('server=10.66.35.14\naddress=/id.youeye/10.76.0.1\naddress=/id.youeye/10.76.0.2', '10.76.0.33'), /multiple/);
  assert.throws(() => appIdentityDnsConfig(undefined, '10.76.0.1'), /forwarding/);
});

test('stable managed issuer never follows a bridge IP or public domain', () => {
  const client = 'youeye-app-notes';
  assert.equal(getAppInternalIdentityBase(client), 'http://id.youeye:3002');
  assert.equal(getAppInternalIdentityBase('youeye-ui'), null);
});
