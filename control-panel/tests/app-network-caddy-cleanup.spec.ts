import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyIncusDeviceMergePatch } from '../src/lib/incus/device-merge-patch';

test('RFC 7396 device merge deletes only the explicit null entry', () => {
  const current = {
    root: { type: 'disk', path: '/', pool: 'default' },
    'net-session-app': { type: 'nic', network: 'yeapp1', name: 'eth-session' },
    'net-other-app': { type: 'nic', network: 'yeapp2', name: 'eth-other' },
  };

  const merged = applyIncusDeviceMergePatch(current, { 'net-session-app': null });

  assert.deepEqual(merged, {
    root: current.root,
    'net-other-app': current['net-other-app'],
  });
  assert.equal(current['net-session-app'].network, 'yeapp1');
  assert.notEqual(merged.root, current.root);
});

test('RFC 7396 device merge deletes multiple proxy entries without touching core devices', () => {
  const current = {
    eth0: { type: 'nic', network: 'incusbr0', name: 'eth0' },
    'app-session-ui': { type: 'proxy', listen: 'tcp:10.76.0.1:3000' },
    'app-session-id': { type: 'proxy', listen: 'tcp:10.76.0.1:3001' },
    'app-other-ui': { type: 'proxy', listen: 'tcp:10.76.0.33:3000' },
  };

  const merged = applyIncusDeviceMergePatch(current, {
    'app-session-ui': null,
    'app-session-id': null,
  });

  assert.deepEqual(merged, {
    eth0: current.eth0,
    'app-other-ui': current['app-other-ui'],
  });
});

test('Caddy cleanup applies an explicit null and sends only writable instance fields', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/lib/incus/app-network.ts'),
    'utf8',
  );
  const start = source.indexOf('export async function removeCaddyFromAppNetwork');
  const end = source.indexOf('// ─── Proxy Device Management', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const cleanup = source.slice(start, end);

  assert.match(
    cleanup,
    /const devicePatch: IncusDeviceMergePatch = \{ \[deviceName\]: null \}/,
  );
  assert.match(cleanup, /applyInstanceDeviceMergePatch\(\s*'youeye-caddy',\s*metadata,\s*devicePatch,/);
});

test('system proxy cleanup null-deletes every matching device before Caddy cleanup', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/lib/incus/app-network.ts'),
    'utf8',
  );
  const start = source.indexOf('export async function removeSystemProxyDevices');
  const end = source.indexOf('// ─── Per-App Egress Isolation ACL', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const cleanup = source.slice(start, end);

  assert.match(cleanup, /const devicePatch: IncusDeviceMergePatch = \{\}/);
  assert.match(cleanup, /devicePatch\[name\] = null/);
  assert.match(cleanup, /applyInstanceDeviceMergePatch\(\s*instance,\s*metadata,\s*devicePatch,/);
  assert.doesNotMatch(cleanup, /incusRequest\('PATCH'/);
});

test('writable instance update never echoes the complete read-only response', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/lib/incus/app-network.ts'),
    'utf8',
  );
  const start = source.indexOf('async function applyInstanceDeviceMergePatch');
  const end = source.indexOf('function assertIncusSuccess', start);
  const update = source.slice(start, end);

  assert.match(update, /devices: applyIncusDeviceMergePatch\(metadata\.devices, devicePatch\)/);
  assert.match(update, /incusRequest\('PUT', `\/1\.0\/instances\/\$\{instance\}`/);
  for (const field of ['architecture', 'config', 'description', 'ephemeral', 'profiles', 'stateful']) {
    assert.match(update, new RegExp(`${field}: metadata\\.${field}`));
  }
  assert.doesNotMatch(update, /\.\.\.metadata/);
});

test('uninstall API returns non-success while durable cleanup is incomplete', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/app/api/market/uninstall/route.ts'),
    'utf8',
  );

  assert.match(
    source,
    /NextResponse\.json\(result, \{ status: result\.success \? 200 : 409 \}\)/,
  );
  assert.match(source, /if \(result\.success\) \{\s*emitEvent\('app\.uninstalled'/);
});

test('network reconciliation does not turn a supported concurrent app mutation into a critical issue', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/lib/incus/app-network.ts'),
    'utf8',
  );
  const start = source.indexOf('export async function reconcileAppNetworks');
  const end = source.indexOf('// ─── Query Helpers', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const reconcile = source.slice(start, end);

  const conflictGuard = reconcile.indexOf('if (error instanceof AppNetworkOperationConflictError) continue;');
  const staleLeaseGuard = reconcile.indexOf('if (!currentLease || leaseAdvanced)');
  const criticalObservation = reconcile.lastIndexOf('await observeIssue({');
  assert.notEqual(conflictGuard, -1);
  assert.notEqual(staleLeaseGuard, -1);
  assert.ok(conflictGuard < criticalObservation);
  assert.ok(staleLeaseGuard < criticalObservation);
  assert.match(reconcile, /currentLease\.operationId !== originalLease\.operationId/);
  assert.match(reconcile, /await resolveIssue\(`\$\{NETWORK_ISSUE_PREFIX\}\.\$\{originalLease\.appId\}`\)/);
});

test('install preflight refusal cannot enter destructive rollback ownership', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src/lib/market/engine.ts'),
    'utf8',
  );
  const start = source.indexOf('export async function installApp');
  const end = source.indexOf('async function installAppLocked', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const install = source.slice(start, end);

  const resourcePreflight = install.indexOf('await preflightInstallResources');
  const pathPreflight = install.indexOf('preflightManifestStorage');
  const networkPreflight = install.indexOf('await preflightAppNetwork');
  const rollbackOwnedTry = install.indexOf("onEvent({ step: 0, totalSteps, status: 'running', message: 'Reserving isolated /27 app network...' });");
  assert.ok(resourcePreflight !== -1 && resourcePreflight < rollbackOwnedTry);
  assert.ok(pathPreflight !== -1 && pathPreflight < rollbackOwnedTry);
  assert.ok(networkPreflight !== -1 && networkPreflight < rollbackOwnedTry);
});
