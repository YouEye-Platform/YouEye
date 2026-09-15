import assert from 'node:assert/strict';
import test from 'node:test';

import { selectRuntimeExtensionDevices } from '../src/lib/infrastructure/oci-deployer';

test('OCI recreation preserves app NAT doorways and Caddy app-network NICs only', () => {
  const selected = selectRuntimeExtensionDevices({
    eth0: { type: 'nic', network: 'incusbr0' },
    root: { type: 'disk', path: '/' },
    volume0: { type: 'disk', path: '/data' },
    proxy0: { type: 'proxy', listen: 'tcp:0.0.0.0:443' },
    'app-memos-pg-proxy': {
      type: 'proxy',
      bind: 'host',
      nat: 'true',
      listen: 'tcp:10.76.8.1:5432',
      connect: 'tcp:10.251.54.10:5432',
    },
    'net-wiki': { type: 'nic', network: 'yeapp1' },
  });

  assert.deepEqual(Object.keys(selected).sort(), ['app-memos-pg-proxy', 'net-wiki']);
});
