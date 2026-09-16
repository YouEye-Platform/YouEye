import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('Control Panel persists the app-network plan before health and reconciliation start', async () => {
  const instrumentation = await readFile(path.join(process.cwd(), 'src/instrumentation.ts'), 'utf8');
  const bootstrap = instrumentation.indexOf('await ensureAppNetworkBootstrapConfig()');
  const health = instrumentation.indexOf('startHealthMonitor()');
  const reconcile = instrumentation.indexOf('reconcileApps()');

  assert.ok(bootstrap >= 0, 'startup must await app-network bootstrap');
  assert.ok(health > bootstrap, 'health monitoring must start after bootstrap');
  assert.ok(reconcile > bootstrap, 'app reconciliation must start after bootstrap');
});

test('empty-network repair persists config and IPAM before strict verification', async () => {
  const source = await readFile(path.join(process.cwd(), 'src/lib/incus/app-network.ts'), 'utf8');
  const patchConfig = source.indexOf('await spineClient.patchConfig({');
  const writeIpam = source.indexOf('await writeIpamStateAtomic(nextState)');
  const strictObserve = source.indexOf('await observeAppNetworkState()', writeIpam);

  assert.ok(patchConfig >= 0);
  assert.ok(writeIpam > patchConfig);
  assert.ok(strictObserve > writeIpam);
  assert.match(source, /installedApps\.length > 0 \|\| activeInstalls\.length > 0/);
  assert.match(source, /isOwnedAppNetwork\(network\) \|\| \/\^yeapp\\d\+\$\//);
  assert.match(source, /repairFn: bootstrapRepair\?\.eligible \? 'repair-empty-app-network' : null/);
});
