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

function fixture(count = 1) {
  const lease = { appId: 'example', bridgeId: 1, bridgeName: 'yeapp1', cidr: '10.76.0.0/27', gateway: '10.76.0.1', state: 'active', operationId: 'fixture-operation' };
  const network = { name: 'yeapp1', config: { 'ipv4.address': '10.76.0.1/27', 'raw.dnsmasq': 'server=192.0.2.14\naddress=/id.youeye/10.76.0.1\nlocal=/id.youeye/', 'user.youeye.kind': 'app-network', 'user.youeye.app_id': 'example', 'user.youeye.cidr': lease.cidr, 'user.youeye.operation_id': lease.operationId } };
  const instances: Record<string, any> = {
    'youeye-control': { devices: { 'youeye-host-ipv4-routes': { type: 'disk', source: '/proc/net/route', path: '/host/proc/net/route', readonly: 'true' } } },
    'youeye-ui': { devices: { unrelated: { type: 'disk', path: '/unrelated' } } },
    'youeye-caddy': { devices: {} },
    'app-example': { status: 'Stopped', devices: { eth0: { type: 'nic', network: 'yeapp1', name: 'eth0' } } },
  };
  const leases = Array.from({ length: count }, (_, i) => ({ ...lease, appId: i ? `example${i + 1}` : lease.appId, bridgeId: i + 1, bridgeName: `yeapp${i + 1}`, cidr: `10.76.${Math.floor(i / 8)}.${(i % 8) * 32}/27`, gateway: `10.76.${Math.floor(i / 8)}.${(i % 8) * 32 + 1}` }));
  const networks = leases.map(l => ({ ...structuredClone(network), name: l.bridgeName, config: { ...network.config, 'ipv4.address': `${l.gateway}/27`, 'raw.dnsmasq': `server=192.0.2.14\naddress=/id.youeye/${l.gateway}\nlocal=/id.youeye/`, 'user.youeye.app_id': l.appId, 'user.youeye.cidr': l.cidr } }));
  for (const l of leases) instances[`app-${l.appId}`] = { status: 'Stopped', devices: { eth0: { type: 'nic', network: l.bridgeName, name: 'eth0' } } };
  const acls: Record<string, any> = {}; const reads: string[] = []; let failNextAclRead = false; let advanceAtAudit = false; let networkReads = 0; let raced = false;
  const writes: string[] = []; let inventories = 0; let admitted = 0; let locked = false; let deny = false; let advance = false;
  const ips: Record<string, string> = { 'youeye-ui': '192.0.2.11', 'youeye-postgres': '192.0.2.12', 'youeye-control': '192.0.2.13', 'youeye-pihole': '192.0.2.14', 'youeye-caddy': '192.0.2.15', 'youeye-pointer': '192.0.2.16' };
  const ok = (metadata: any) => ({ type: 'sync', status_code: 200, metadata: structuredClone(metadata) });
  class AdmissionError extends Error {}
  const mocks: Record<string, any> = {
    './server': { incusRequest: async (method: string, url: string, body?: any) => {
      if (method !== 'GET') { assert.ok(locked, 'every effect stays under app admission and lock'); writes.push(`${method} ${url}`); }
      if (method === 'GET') reads.push(url);
      if (url === '/1.0/networks') { inventories++; return ok(networks.map(n => `/1.0/networks/${n.name}`)); }
      const net = networks.find(n => url === `/1.0/networks/${n.name}`);
      if (net) {
        networkReads++;
        if (advanceAtAudit && networkReads === count + 1) { leases[0].operationId = 'new-operation'; networks[0].config['user.youeye.operation_id'] = 'new-operation'; raced = true; }
        if (method !== 'GET') Object.assign(net.config, body.config); return ok(net);
      }
      if (url === '/1.0/network-acls' && method === 'POST') { acls[body.name] = structuredClone(body); return ok({}); }
      if (url.startsWith('/1.0/network-acls/')) {
        if (method === 'GET' && failNextAclRead) { failNextAclRead = false; throw new Error('provider disconnected'); }
        const name = url.split('/').pop()!;
        if (method === 'PUT') acls[name] = structuredClone(body);
        return acls[name] ? ok(acls[name]) : { type: 'error', error_code: 404 };
      }
      const name = url.split('/')[3];
      if (instances[name]) { if (method === 'PATCH') instances[name].devices = structuredClone(body.devices); return ok(instances[name]); }
      throw Error(`Unexpected request ${method} ${url}`);
    } },
    './config-equality': equality,
    './app-network-caddy-nic': caddy,
    './static-ips': { getSystemStaticIP: async (name: string) => ips[name] },
    'fs/promises': { readFile: async (p: string) => p.endsWith('route') ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' : '{}' },
    'yaml': { parse: JSON.parse },
    './app-network-ipam': { ...ipam, readIpamState: async () => structuredClone({ leases }), withAppNetworkOperationLock: async (_app: string, _operation: string, fn: () => Promise<any>) => {
      locked = true; try { return await fn(); } finally { locked = false; }
    } },
    '@/lib/market/update-admission': { AppLifecycleAdmissionError: AdmissionError, withAppLifecycle: async (_app: string, fn: () => Promise<any>) => {
      admitted++; if (deny) throw new AdmissionError('reserved');
      if (advance) { leases[0].operationId = 'new-operation'; networks[0].config['user.youeye.operation_id'] = 'new-operation'; }
      return fn();
    } },
    '@/lib/health/issues': { resolveIssue: async () => {}, observeIssue: async () => {} },
    '../market/install-tracker': { getAllActiveInstalls: () => [] },
    '../market/metadata': { readInstallMetadata: async (appId: string) => ({ appId, lifecycleState: 'installed', containers: [`app-${appId}`], databaseMode: 'none', hasSSO: false }) },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/incus/app-network.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, structuredClone, process: { env: {} }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    require(name: string) { if (name in mocks) return mocks[name]; if (['crypto', 'path', 'node:async_hooks'].includes(name)) return require(name); return {}; },
  });
  return { reconcile: exports.reconcileAppNetworks, instances, writes, reads, networks, get acl() { return acls['ye-app-example-egress']; }, disconnect() { failNextAclRead = true; }, race() { advanceAtAudit = true; networkReads = 0; acls['ye-app-example-egress'].description = 'racing drift'; }, raced: () => raced, inventories: () => inventories, admitted: () => admitted, deny() { deny = true; }, advance() { advance = true; } };
}

test('real network reconciler converges then performs zero unchanged writes with one full inventory per pass', async () => {
  const f = fixture();
  assert.equal((await f.reconcile()).unresolved.length, 0);
  assert.ok(f.writes.length >= 4);
  f.writes.length = 0; const before = f.inventories(); const admissions = f.admitted();
  const unchanged = await f.reconcile();
  assert.equal(unchanged.unresolved.length, 0);
  assert.equal(unchanged.observedNetworks.length, 1);
  assert.equal(f.admitted(), admissions, 'no-effect audits do not acquire mutation leases');
  assert.deepEqual(f.writes, []);
  assert.equal(f.inventories() - before, 1, 'unchanged audit never enters full mutation observation');
  assert.equal(f.instances['app-example'].status, 'Stopped');
  assert.equal(f.instances['youeye-ui'].devices.unrelated.path, '/unrelated');
});

test('real ACL and device drift are repaired once; the next pass is read-only', async () => {
  const f = fixture(); await f.reconcile(); f.writes.length = 0;
  f.acl.egress[0].action = 'reject';
  f.instances['app-example'].devices.eth0['security.mac_filtering'] = 'false';
  f.instances['youeye-ui'].devices['app-example-ui-proxy'].connect = 'tcp:192.0.2.99:3000';
  const repaired = await f.reconcile();
  assert.equal(repaired.unresolved.length, 0);
  assert.equal(repaired.observedNetworks, undefined, 'a repair must refresh the outer inventory');
  assert.equal(f.writes.length, 3);
  f.writes.length = 0; await f.reconcile(); assert.deepEqual(f.writes, []);
});

test('reserved or advanced app ownership prevents reconciliation effects', async () => {
  for (const change of ['deny', 'advance'] as const) {
    const f = fixture(); f[change]();
    const changed = await f.reconcile();
    assert.equal(changed.unresolved.length, 0);
    assert.equal(changed.observedNetworks, undefined, 'ownership/admission races must not lend stale inventory');
    assert.deepEqual(f.writes, []); assert.equal(f.admitted(), 1);
  }
});

test('ACL equality tolerates only empty optional fields and ordering, and detects extra permissions', () => {
  const expected = { description: 'owned', egress: [{ action: 'reject', state: 'enabled', destination: '192.0.2.0/24' }] };
  const actual = { ...expected, config: {}, ingress: [], egress: [{ ...expected.egress[0], source: '' }] };
  assert.equal(equality.sameIncusAcl(actual, expected), true);
  actual.egress.push({ action: 'allow', state: 'enabled', destination: '198.51.100.0/24', source: '' });
  assert.equal(equality.sameIncusAcl(actual, expected), false);
});


test('17 unchanged apps share one full audit and one system-device read per pass', async () => {
  const f = fixture(17); await f.reconcile(); f.writes.length = 0; f.reads.length = 0;
  const before = f.inventories();
  assert.equal((await f.reconcile()).unresolved.length, 0);
  assert.equal(f.inventories() - before, 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads.filter(p => p === '/1.0/instances/youeye-ui').length, 1);
  assert.equal(f.reads.filter(p => p === '/1.0/instances/youeye-caddy').length, 1);
  // An externally changed ACL is never hidden by the preceding pass's reads.
  f.acl.description = 'external drift';
  await f.reconcile();
  assert.deepEqual(f.writes, ['PUT /1.0/network-acls/ye-app-example-egress']);
});

test('a provider disconnect cannot authorize a cached repair and the next live read recovers', async () => {
  const f = fixture(); await f.reconcile(); f.writes.length = 0;
  f.acl.description = 'drift'; f.disconnect();
  assert.equal((await f.reconcile()).unresolved.length, 0);
  assert.deepEqual(f.writes, ['PUT /1.0/network-acls/ye-app-example-egress']);
});

test('ownership changing during the no-effect audit is rechecked before any repair', async () => {
  const f = fixture(); await f.reconcile(); f.writes.length = 0; f.race();
  assert.equal((await f.reconcile()).unresolved.length, 0);
  assert.equal(f.raced(), true);
  assert.deepEqual(f.writes, []);
});

test('global ownership collisions still fail the full audit before the fast path', async () => {
  const f = fixture(); await f.reconcile(); f.writes.length = 0;
  f.networks[0].config['user.youeye.kind'] = 'foreign';
  assert.ok((await f.reconcile()).unresolved.length > 0);
  assert.deepEqual(f.writes, []);
});

test('a read-only drift detection cannot bypass a reserved mutation lease', async () => {
  const f = fixture(); await f.reconcile(); f.writes.length = 0;
  f.acl.description = 'drift while updater owns the app'; f.deny();
  const result = await f.reconcile();
  assert.deepEqual(f.writes, []);
  assert.equal(f.acl.description, 'drift while updater owns the app');
  assert.equal(result.observedNetworks, undefined);
});
