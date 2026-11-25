/**
 * YE-222, Iris's batch-1 review: the reconcile pass finishes an unfinished removal only in the mode the user asked
 * last, read under the locks, never from the snapshot it took before them; it leaves the removal to a removal request
 * that is running or waiting; and a failed attempt's end mark or a new request's mode is computed from the lease as
 * read inside the IPAM write lock, so a keep request recorded lock-free in between is never overwritten.
 *
 * The real app-network.ts runs here (as in app-network-noop.spec.ts) against an in-memory IPAM state and a fake Incus.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as ipam from '../src/lib/incus/app-network-ipam';
import * as equality from '../src/lib/incus/config-equality';
import * as caddy from '../src/lib/incus/app-network-caddy-nic';
const require = createRequire(import.meta.url);

type Lease = { appId: string; bridgeId: number; bridgeName: string; cidr: string; gateway: string; state: string;
  operationId: string; failure?: { stage: string; message: string; observedAt: string } };

function harness(stage: string) {
  const lease: Lease = { appId: 'sonarr', bridgeId: 1, bridgeName: 'yeapp1', cidr: '10.76.0.0/27', gateway: '10.76.0.1',
    state: 'cleanup_pending', operationId: 'op-1', failure: { stage, message: 'Cleanup did not reach all verified postconditions', observedAt: 'then' } };
  const disk = { leases: [lease] } as { leases: Lease[] };
  const hooks: { beforeLifecycleWork?: () => void; insideMutate?: (state: { leases: Lease[] }) => void } = {};
  const cleanups: Array<{ appId: string; keepData?: boolean }> = [];
  const ok = (metadata: unknown) => ({ type: 'sync', status_code: 200, metadata });
  const mocks: Record<string, unknown> = {
    './server': { incusRequest: async (method: string, url: string) => {
      if (method === 'GET' && url === '/1.0/networks') return ok([]);
      if (method === 'GET' && url === '/1.0/instances/youeye-control') {
        return ok({ devices: { 'youeye-host-ipv4-routes': { type: 'disk', source: '/proc/net/route', path: '/host/proc/net/route', readonly: 'true' } } });
      }
      throw new Error(`Unexpected Incus request ${method} ${url}`);
    } },
    './config-equality': equality,
    './app-network-caddy-nic': caddy,
    './static-ips': { getSystemStaticIP: async () => '192.0.2.11' },
    'fs/promises': { readFile: async (p: string) => p.endsWith('route') ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' : '{}' },
    'yaml': { parse: JSON.parse },
    './app-network-ipam': {
      ...ipam,
      readIpamState: async () => structuredClone(disk),
      mutateIpamState: async (_options: unknown, mutation: (state: { leases: Lease[] }) => unknown) => {
        const state = structuredClone(disk);
        hooks.insideMutate?.(state);
        const result = await mutation(state);
        disk.leases = state.leases;
        return result;
      },
      withAppNetworkOperationLock: async (_app: string, _operation: string, fn: () => Promise<unknown>) => fn(),
    },
    '@/lib/market/update-admission': {
      AppLifecycleAdmissionError: class extends Error {},
      isUserOperationWaiting: () => false,
      withAppLifecycle: async (_app: string, fn: () => Promise<unknown>) => { hooks.beforeLifecycleWork?.(); return fn(); },
    },
    '@/lib/health/issues': { resolveIssue: async () => {}, observeIssue: async () => {} },
    '@/lib/market/install-tracker': { describeErrorChainForLog: (error: unknown) => String(error) },
    '../market/install-tracker': { getAllActiveInstalls: () => [] },
    '../market/metadata': { readInstallMetadata: async (appId: string) => ({ appId, lifecycleState: 'installed', cleanupPending: true, containers: [] }) },
    '../market/reconciler': { cleanupAppByScan: async (appId: string, options: { keepData?: boolean }) => {
      cleanups.push({ appId, keepData: options?.keepData });
      return { repaired: [], unresolved: [] };
    } },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/incus/app-network.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, structuredClone, process: { env: {} }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    require(name: string) { if (name in mocks) return mocks[name]; if (['crypto', 'path', 'node:async_hooks'].includes(name)) return require(name); return {}; },
  });
  return { api: exports, disk, hooks, cleanups };
}

test('BLOCKER order: a failed delete attempt, the pass\'s snapshot, then a --keep-data request that stopped early: the pass keeps the data', async () => {
  const h = harness('uninstall-delete-data');
  // The keep request runs between the pass's snapshot and its admission: it records keep and stops early (say at
  // verifyAdmissionCleanup), before anything is retained, so keptDataRefusal has nothing to catch.
  h.hooks.beforeLifecycleWork = () => { h.disk.leases[0].failure = { stage: 'uninstall-keep-data', message: 'The removal was asked again', observedAt: 'now' }; };
  const result = await h.api.reconcileAppNetworks();
  assert.deepEqual(JSON.parse(JSON.stringify(result.unresolved)), []);
  assert.deepEqual(h.cleanups, [{ appId: 'sonarr', keepData: true }], 'finished as keep-data, the last request');
});

test('without a newer request the pass finishes in the recorded mode (delete-data stays delete-data)', async () => {
  const h = harness('uninstall-delete-data');
  await h.api.reconcileAppNetworks();
  assert.deepEqual(h.cleanups, [{ appId: 'sonarr', keepData: false }]);
  const keep = harness('scan-cleanup-keep-data');
  await keep.api.reconcileAppNetworks();
  assert.deepEqual(keep.cleanups, [{ appId: 'sonarr', keepData: true }]);
});

test('a removal request running or waiting for the locks: the pass leaves the removal to it', async () => {
  const h = harness('uninstall-delete-data');
  let during: unknown[] | undefined;
  await h.api.withRemovalRequest('sonarr', async () => {
    assert.equal(h.api.isRemovalRequested('sonarr'), true);
    await h.api.reconcileAppNetworks();
    during = [...h.cleanups];
  });
  assert.deepEqual(during, [], 'nothing finished while the request ran');
  assert.equal(h.api.isRemovalRequested('sonarr'), false, 'the request ended');
  await h.api.reconcileAppNetworks();
  assert.deepEqual(h.cleanups, [{ appId: 'sonarr', keepData: false }], 'finished on a later pass');
  // A request that throws ends too.
  await assert.rejects(h.api.withRemovalRequest('sonarr', async () => { throw new Error('busy'); }), /busy/);
  assert.equal(h.api.isRemovalRequested('sonarr'), false);
});

test('a failing attempt\'s end mark reads the lease inside the write lock: a keep recorded after its first read stays', async () => {
  const h = harness('uninstall-delete-data');
  // Between markAppNetworkCleanupPending's first read and its write, a keep request records keep (lock-free).
  h.hooks.insideMutate = (state) => { state.leases[0].failure = { stage: 'uninstall-keep-data', message: 'asked again', observedAt: 'now' }; };
  await h.api.markAppNetworkCleanupPending('sonarr', 'scan-cleanup-delete-data', 'instance remains');
  assert.equal(h.disk.leases[0].failure?.stage, 'uninstall-keep-data');
  // Without the keep in between, the failed attempt's own mode is written.
  const plain = harness('delete');
  await plain.api.markAppNetworkCleanupPending('sonarr', 'scan-cleanup-delete-data', 'instance remains');
  assert.equal(plain.disk.leases[0].failure?.stage, 'scan-cleanup-delete-data');
  // A lease released meanwhile: nothing is written, null comes back.
  const gone = harness('uninstall-delete-data');
  gone.hooks.insideMutate = (state) => { state.leases = []; };
  assert.equal(await gone.api.markAppNetworkCleanupPending('sonarr', 'uninstall-delete-data', 'x'), null);
  assert.deepEqual(gone.disk.leases, []);
});

test('recordRemovalMode takes the operation and the stage from the lease read inside the write lock', async () => {
  const h = harness('uninstall-delete-data');
  h.hooks.insideMutate = (state) => { state.leases[0].operationId = 'op-2'; };
  await h.api.recordRemovalMode('sonarr', true);
  assert.equal(h.disk.leases[0].failure?.stage, 'uninstall-keep-data');
  assert.equal(h.disk.leases[0].operationId, 'op-2', 'never an older read\'s operation');
  // Already recorded by the time of the write: left as it is (no new observedAt).
  const same = harness('uninstall-delete-data');
  same.hooks.insideMutate = (state) => { state.leases[0].failure = { stage: 'uninstall-keep-data', message: 'asked again', observedAt: 'earlier' }; };
  await same.api.recordRemovalMode('sonarr', true);
  assert.equal(same.disk.leases[0].failure?.observedAt, 'earlier');
  // Released meanwhile: nothing is written.
  const gone = harness('uninstall-delete-data');
  gone.hooks.insideMutate = (state) => { state.leases = []; };
  await gone.api.recordRemovalMode('sonarr', true);
  assert.deepEqual(gone.disk.leases, []);
});
