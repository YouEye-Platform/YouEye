import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertLegacyNetworkCandidate,
  parseLegacySubnetRegistry,
  readLegacySubnetRegistry,
} from '../src/lib/incus/app-network-legacy-migration';

const candidate = {
  appId: 'searxng',
  bridgeId: 6,
  network: {
    name: 'yeapp6',
    description: 'App network: searxng',
    type: 'bridge',
    managed: true,
    config: {
      'dns.domain': 'youeye',
      'ipv4.address': '10.76.6.1/24',
      'ipv4.dhcp': 'true',
      'ipv4.nat': 'true',
      'ipv6.address': 'none',
      'raw.dnsmasq': 'server=10.251.54.14',
    },
    used_by: [
      '/1.0/instances/app-searxng-main',
      '/1.0/instances/app-searxng-redis',
      '/1.0/instances/youeye-caddy',
    ],
  },
  containerNames: ['app-searxng-main', 'app-searxng-redis'],
  instances: [
    { name: 'app-searxng-main', devices: { eth0: { type: 'nic', network: 'yeapp6' } } },
    { name: 'app-searxng-redis', devices: { eth0: { type: 'nic', network: 'yeapp6' } } },
  ],
  caddy: {
    name: 'youeye-caddy',
    devices: { 'net-searxng': { type: 'nic', network: 'yeapp6' } },
  },
  piholeIP: '10.251.54.14',
};

test('legacy registry parser accepts only the exact unique app-to-subnet map', () => {
  assert.deepEqual(parseLegacySubnetRegistry({ next: 10, allocated: { wiki: 1, searxng: 6 } }), {
    next: 10,
    allocated: { wiki: 1, searxng: 6 },
  });
  assert.throws(() => parseLegacySubnetRegistry({ next: 10, allocated: { wiki: 1 }, extra: true }), /unfamiliar shape/i);
  assert.throws(() => parseLegacySubnetRegistry({ next: 10, allocated: { wiki: 1, notes: 1 } }), /reuses/i);
  assert.throws(() => parseLegacySubnetRegistry({ next: 10, allocated: { '../wiki': 1 } }), /invalid allocation/i);
});

test('legacy migration proof requires exact bridge, workload, Caddy, DNS, and ownership state', () => {
  assert.doesNotThrow(() => assertLegacyNetworkCandidate(candidate));
  const owned = structuredClone(candidate);
  Object.assign(owned.network.config, {
    'user.youeye.kind': 'app-network',
    'user.youeye.app_id': 'searxng',
    'user.youeye.cidr': '10.76.6.0/24',
    'user.youeye.operation_id': 'legacy-subnets-v1:searxng:6',
  });
  assert.doesNotThrow(() => assertLegacyNetworkCandidate(owned));

  const extraHolder = structuredClone(candidate);
  extraHolder.network.used_by.push('/1.0/instances/unrelated');
  assert.throws(() => assertLegacyNetworkCandidate(extraHolder), /attached instances differ/i);
  const wrongDns = structuredClone(candidate);
  wrongDns.network.config['raw.dnsmasq'] = 'server=192.0.2.1';
  assert.throws(() => assertLegacyNetworkCandidate(wrongDns), /raw.dnsmasq mismatch/i);
  const partialOwner = structuredClone(candidate);
  partialOwner.network.config['user.youeye.kind'] = 'app-network';
  assert.throws(() => assertLegacyNetworkCandidate(partialOwner), /ownership metadata is partial/i);
  const wrongCaddy = structuredClone(candidate);
  wrongCaddy.caddy.devices['net-searxng'].network = 'yeapp7';
  assert.throws(() => assertLegacyNetworkCandidate(wrongCaddy), /Caddy attachment mismatch/i);
});

test('legacy registry reader rejects writable or linked state and accepts the retired root-owned mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'youeye-legacy-network-'));
  const directory = path.join(root, 'networks');
  const registry = path.join(directory, 'subnets.json');
  try {
    await mkdir(directory, { mode: 0o755 });
    await writeFile(registry, '{"next":2,"allocated":{"wiki":1}}\n', { mode: 0o644 });
    assert.deepEqual(await readLegacySubnetRegistry(registry), { next: 2, allocated: { wiki: 1 } });
    await chmod(registry, 0o666);
    await assert.rejects(readLegacySubnetRegistry(registry), /trusted file shape/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production migration persists proof before annotating and runs before collision refusal', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    path.join(process.cwd(), 'src/lib/incus/app-network.ts'),
    'utf8',
  );
  const migration = source.indexOf('const durableLeases = await mutateIpamState');
  const annotation = source.indexOf("'PATCH', `/1.0/networks/${lease.bridgeName}`");
  const invocation = source.indexOf('await migrateLegacyAppNetworks');
  const refusal = source.indexOf('Unowned Incus network name collision');
  assert.ok(migration > 0 && annotation > migration);
  assert.ok(invocation > 0 && refusal > invocation);
});
