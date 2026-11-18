// Update preflight on production shapes: a connected app has a NIC per connection (net-<app>, koshka VM 156: sonarr
// has eth0, net-prowlarr, net-qbittorrent), and the space budget depends on the pool driver.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as inventory from '../src/lib/market/update-inventory';
import type { InstallMetadata } from '../src/lib/market/types';

const GIB = 1024 ** 3;
const aclName = (container: string, target: string) => `ye-grant-${`${container}-to-${target}`.slice(0, 42)}`;

function loadProvider(require: (name: string) => unknown) {
  const output = ts.transpileModule(readFileSync(new URL('../src/lib/market/update-provider.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output)(require, exports);
  return exports;
}

interface Box {
  devices: Record<string, Record<string, string>>;
  bridges: Array<{ from: string; to: string; active: boolean; direction?: string; accessMode?: string }>;
  driver: string;
  rootUsage: number;
  volumes: Array<{ name: string; used: number; kind: 'app' | 'shared'; group?: string; pool?: string }>;
}

function box(overrides: Partial<Box> = {}): Box {
  return {
    devices: {
      root: { type: 'disk', path: '/', pool: 'default' },
      eth0: { type: 'nic', network: 'yeapp7' },
      'net-prowlarr': { type: 'nic', network: 'yeapp3', 'security.acls': aclName('app-sonarr', 'prowlarr') },
      'net-qbittorrent': { type: 'nic', network: 'yeapp4', 'security.acls': aclName('app-sonarr', 'qbittorrent') },
    },
    bridges: [
      { from: 'sonarr', to: 'prowlarr', active: true },
      { from: 'sonarr', to: 'qbittorrent', active: true },
    ],
    driver: 'zfs',
    rootUsage: 2 * GIB,
    volumes: [],
    ...overrides,
  };
}

async function observe(state: Box) {
  const networks: Record<string, string> = { yeapp7: 'sonarr', yeapp3: 'prowlarr', yeapp4: 'qbittorrent', yeapp9: 'radarr' };
  const provider = loadProvider(name => {
    if (name === './update-inventory') return inventory;
    if (name === '@/lib/incus/snapshot') return { containerState: async () => 'Running' };
    if (name === '../bridges/store') return { getBridgesForApp: async () => state.bridges };
    if (name === '../incus/app-network') return { integrationAclName: aclName };
    if (name === './caddy-ca') return { isManagedTrustMount: () => false };
    if (name === '@/lib/incus/server') return { incusRequest: async (_method: string, url: string) => {
      const volume = state.volumes.find(v => url.includes(`/volumes/custom/${v.name}`));
      const network = /^\/1\.0\/networks\/(\w+)$/.exec(url)?.[1];
      const metadata = url === '/1.0/instances/app-sonarr' ? { config: { 'volatile.uuid': 'runtime' }, expanded_devices: state.devices }
        : network ? { config: { 'user.youeye.kind': 'app-network', 'user.youeye.app_id': networks[network] } }
        : url === '/1.0/storage-pools/default' ? { driver: state.driver }
        : url === '/1.0/storage-pools/default/resources' ? { space: { total: 100 * GIB, used: 50 * GIB } }
        // Incus reports every pool-backed disk device, custom volumes included (named as in expanded_devices).
        : url === '/1.0/instances/app-sonarr/state' ? { disk: { root: { usage: state.rootUsage },
          ...Object.fromEntries(state.volumes.map(v => [v.name, { usage: v.used }])) } }
        : url === '/1.0/storage-pools/media-pool' ? { driver: 'zfs' }
        : url === '/1.0/storage-pools/media-pool/resources' ? { space: { total: 4000 * GIB, used: 3990 * GIB } }
        : volume && url.endsWith('/state') ? { usage: { used: volume.used } }
        : volume ? { content_type: 'filesystem', used_by: ['/1.0/instances/app-sonarr'],
          config: volume.kind === 'shared' ? { 'user.youeye.kind': 'shared', 'user.youeye.storage_group': volume.group }
            : { 'user.youeye.kind': 'app', 'user.youeye.app_id': 'sonarr' } }
        : null;
      if (!metadata) throw new Error(`unexpected ${url}`);
      return { type: 'sync', metadata };
    } };
    return {};
  });
  const metadata = { appId: 'sonarr', containers: [{ containerName: 'app-sonarr' }],
    storageVolumes: state.volumes.map(v => ({ pool: v.pool ?? 'default', name: v.name })) } as unknown as InstallMetadata;
  return provider.observeUpdateInventory(metadata);
}

async function refused(state: Box, pattern: RegExp) {
  await assert.rejects(observe(state), (error: any) => error.code === 'foreign-or-missing-container' && pattern.test(error.message));
}

test('a connected app passes preflight: one NIC on its own network, one per active connection', async () => {
  const result = await observe(box());
  assert.equal(result.observations.containers.length, 1);
});

test('connection NICs need an active connection, the peer network and their scoped ACL', async () => {
  // Connection removed (or never approved), NIC left behind.
  await refused(box({ bridges: [{ from: 'sonarr', to: 'prowlarr', active: true }] }), /net-qbittorrent/);
  // The reverse: an active connection whose NIC is already gone is refused before any effect, by name.
  const lost = box();
  delete lost.devices['net-qbittorrent'];
  await assert.rejects(observe(lost), (error: any) => error.code === 'connection-interface-missing' && /qbittorrent/.test(error.message));
  await refused(box({ bridges: [{ from: 'sonarr', to: 'prowlarr', active: true }, { from: 'sonarr', to: 'qbittorrent', active: false }] }), /net-qbittorrent/);
  // A proxy connection has no NIC: a NIC claiming one is foreign.
  await refused(box({ bridges: [{ from: 'sonarr', to: 'prowlarr', active: true }, { from: 'sonarr', to: 'qbittorrent', active: true, accessMode: 'proxy' }] }), /net-qbittorrent/);
  // Name says one app, network belongs to another.
  const wrongNetwork = box();
  wrongNetwork.devices['net-qbittorrent'] = { ...wrongNetwork.devices['net-qbittorrent'], network: 'yeapp9' };
  await refused(wrongNetwork, /net-qbittorrent/);
  // Missing or foreign ACL.
  const wrongAcl = box();
  wrongAcl.devices['net-prowlarr'] = { ...wrongAcl.devices['net-prowlarr'], 'security.acls': 'something-else' };
  await refused(wrongAcl, /net-prowlarr/);
  // A NIC that isn't a connection device at all.
  const extra = box();
  extra.devices.eth1 = { type: 'nic', network: 'yeapp9' };
  await refused(extra, /eth1/);
  // Two NICs on the app's own network, or none.
  const twoOwn = box();
  twoOwn.devices.eth1 = { type: 'nic', network: 'yeapp7' };
  await refused(twoOwn, /exactly one NIC/);
  const noOwn = box();
  delete noOwn.devices.eth0;
  await refused(noOwn, /exactly one NIC/);
});

test('a both-ways connection gives the target a NIC back to the source', async () => {
  const state = box({ bridges: [{ from: 'prowlarr', to: 'sonarr', active: true, direction: 'both-ways' },
    { from: 'sonarr', to: 'qbittorrent', active: true }] });
  await observe(state);
  state.bridges[0].direction = 'one-way';
  await refused(state, /net-prowlarr/);
});

test('copy-on-write pools budget churn plus 1 GiB; full-copy pools twice the data; shared folders never count', async () => {
  const volumes: Box['volumes'] = [
    { name: 'ye-app-sonarr-config', used: 8 * GIB, kind: 'app' },
    { name: 'ye-shared-media', used: 300 * GIB, kind: 'shared', group: 'media' },
  ];
  const own = 2 * GIB + 8 * GIB;
  const zfs = (await observe(box({ volumes }))).observations.pools[0];
  // The rebuild rewrites the root (in full); data volumes churn (10 %); shared folders never count.
  assert.equal(zfs.checkpointBytes, 2 * GIB + Math.ceil(8 * GIB / 10));
  assert.equal(zfs.cleanupReserveBytes, GIB);
  const dir = (await observe(box({ volumes, driver: 'dir' }))).observations.pools[0];
  assert.equal(dir.checkpointBytes, own * 2);
  assert.equal(dir.cleanupReserveBytes, Math.ceil(own / 10));
});

test('a pool that holds only shared folders needs no recovery space', async () => {
  const result = await observe(box({ volumes: [
    { name: 'ye-app-sonarr-config', used: GIB, kind: 'app' },
    { name: 'ye-shared-media', used: 3000 * GIB, kind: 'shared', group: 'media', pool: 'media-pool' },
  ] }));
  assert.deepEqual(result.observations.pools.map((p: { name: string }) => p.name), ['default']);
});
