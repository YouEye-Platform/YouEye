import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as inventory from '../src/lib/market/update-inventory';
import type { InstallMetadata } from '../src/lib/market/types';

function moduleAt(name: string, require: (name: string) => unknown) {
  const output = ts.transpileModule(readFileSync(new URL(`../src/lib/market/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output)(require, exports);
  return exports;
}
const trust = moduleAt('caddy-ca', () => ({}));
const device = { type: 'disk', source: '/var/lib/youeye/apps/fixture/trust',
  path: '/etc/youeye/trust', readonly: 'true', shift: 'true' };
async function observe(mount: Record<string, string>) {
  const provider = moduleAt('update-provider', name => {
    if (name === './caddy-ca') return trust;
    if (name === './update-inventory') return inventory;
    if (name === '@/lib/incus/snapshot') return { containerState: async () => 'Running' };
    if (name === '@/lib/incus/server') return { incusRequest: async (_method: string, url: string) => {
      const metadata = url === '/1.0/instances/app-fixture'
        ? { config: { 'volatile.uuid': 'runtime' }, expanded_devices: {
          root: { type: 'disk', path: '/', pool: 'default' },
          eth0: { type: 'nic', network: 'owned' }, trust: mount } }
        : url === '/1.0/networks/owned'
          ? { config: { 'user.youeye.kind': 'app-network', 'user.youeye.app_id': 'fixture' } }
          : url === '/1.0/storage-pools/default' ? { driver: 'dir' }
            : url === '/1.0/instances/app-fixture/state' ? { disk: { root: { usage: 1000 } } }
              : { space: { total: 1_000_000_000, used: 1000 } };
      return { type: 'sync', metadata };
    } };
    return {};
  });
  return provider.observeUpdateInventory({ appId: 'fixture',
    containers: [{ containerName: 'app-fixture' }], storageVolumes: [] } as unknown as InstallMetadata);
}

test('actual inventory keeps the exact current platform trust mount outside app data checkpoints', async () => {
  const result = await observe(device);
  assert.deepEqual(result.observations.containers[0].volumes, []);
  assert.deepEqual(result.instances[0].expanded_devices.trust, device);
  assert.deepEqual(result.observations.volumes, []);
});

test('foreign, writable, alternate-path and extended host mounts still refuse before effects', async () => {
  for (const changed of [
    { source: '/var/lib/youeye/apps/other/trust' }, { readonly: 'false' },
    { path: '/data' }, { source: '/var/lib/youeye/apps/fixture/trust/../data' },
    { pool: 'default' }, { recursive: 'true' }, { shift: 'false' },
  ]) {
    await assert.rejects(observe({ ...device, ...changed }),
      (error: unknown) => error instanceof inventory.AppUpdatePreflightError && error.code === 'unknown-mutable-volume');
  }
  assert.equal(trust.isManagedTrustMount('../fixture', device), false);
});
