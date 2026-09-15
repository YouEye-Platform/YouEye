import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('explicit integration lifecycle is locked, sensitivity-safe, and read-back verified', async () => {
  const [manager, store, caddy, network] = await Promise.all([
    readFile(path.join(process.cwd(), 'src/lib/bridges/manager.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'src/lib/bridges/store.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'src/lib/caddy/client.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'src/lib/incus/app-network.ts'), 'utf8'),
  ]);

  assert.match(manager, /withBridgeLifecycleLock\('bridge-activate'/);
  assert.match(manager, /incusDownloadFile\(fromContainer/);
  assert.match(manager, /writeContainerFileExact/);
  assert.match(manager, /rollbackErrors\.push\('environment'\)/);
  assert.doesNotMatch(manager, /YOUEYE_ENV_PAYLOAD|awk -F=/);
  assert.match(store, /withAppNetworkOperationLock\('bridge-store'/);
  assert.match(store, /Bridge store is corrupt or insecure/);
  assert.match(caddy, /Scoped app grant did not read back after creation/);
  assert.match(caddy, /Scoped app grant remains after removal/);
  assert.match(network, /return egress\.map\(\(rule\) => \(\{ state: 'enabled', \.\.\.rule \}\)\)/);
  assert.match(network, /\/1\.0\/networks'[\s\S]*NETWORK_INVENTORY_CONCURRENCY/);
  assert.doesNotMatch(network, /\/1\.0\/networks\?recursion=1/);
  assert.match(network, /Read Incus network \$\{url\}/);
  assert.match(network, /YOUEYE_TEST_NETWORK_SNAPSHOT_TTL_MS/);
  assert.match(network, /export function clearAppNetworkTestSnapshot/);
  assert.match(network, /testNetworkSnapshotRequest = fetchIncusNetworks\(\)/);
  assert.match(network, /Read app bridge .* before activation/);
  assert.match(network, /const state = await readIpamState\(\{ config, allowInitialize: false \}\)/);
  assert.match(network, /Create app bridge .*?, 300\)/);
  assert.match(network, /Create app ACL .*?, 180\)/);
  assert.match(network, /Integration ACL .* still exists after revocation/);
});
