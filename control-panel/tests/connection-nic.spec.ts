import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as caddy from '../src/lib/incus/app-network-caddy-nic';
import * as connectionNic from '../src/lib/incus/connection-nic';
import { connectionInterface } from '../src/lib/incus/connection-nic';
import * as ipam from '../src/lib/incus/app-network-ipam';
const require = createRequire(import.meta.url);

// Load app-network.ts with a fake Incus: instances, ACLs and leases in memory.
function fixture(options: { sourceExists: boolean; targetAddress?: string; targetNetwork?: string }) {
  const acls: Record<string, any> = {};
  const instances: Record<string, any> = {
    'youeye-control': { devices: { 'youeye-host-ipv4-routes': { type: 'disk', source: '/proc/net/route', path: '/host/proc/net/route', readonly: 'true' } } },
    ...(options.sourceExists ? { 'app-sonarr': { devices: { eth0: { type: 'nic', network: 'yeapp3', name: 'eth0' } } } } : {}),
  };
  const writes: string[] = [];
  const execs: string[] = [];
  // Host-side addresses (NIC lease by MAC), as `hostSideNICAddress` reads them; the target's may change.
  const target = { address: options.targetAddress ?? '10.76.0.5', network: options.targetNetwork ?? 'yeapp1' };
  const addressLookups: Array<{ name: string; iface: string; allowStopped?: boolean }> = [];
  const ok = (metadata: any) => ({ type: 'sync', status_code: 200, metadata: structuredClone(metadata) });
  const lease = { appId: 'prowlarr', bridgeId: 1, bridgeName: 'yeapp1', cidr: '10.76.0.0/27', gateway: '10.76.0.1', state: 'active', operationId: 'op' };
  const network = { name: 'yeapp1', type: 'bridge', managed: true, used_by: ['/1.0/instances/app-prowlarr'], config: { 'ipv4.address': '10.76.0.1/27', 'raw.dnsmasq': 'server=192.0.2.14\naddress=/id.youeye/10.76.0.1\nlocal=/id.youeye/', 'user.youeye.kind': 'app-network', 'user.youeye.app_id': 'prowlarr', 'user.youeye.cidr': lease.cidr, 'user.youeye.operation_id': lease.operationId } };
  const mocks: Record<string, any> = {
    './server': {
      incusRequest: async (method: string, url: string, body?: any) => {
        if (method !== 'GET') writes.push(`${method} ${url}`);
        if (url === '/1.0/networks' || url.startsWith('/1.0/networks?')) return ok(url.includes('recursion') ? [network] : ['/1.0/networks/yeapp1']);
        if (url.startsWith('/1.0/networks/')) return ok(network);
        if (url === '/1.0/network-acls' && method === 'POST') {
          // Incus refuses a rule without an explicit state.
          if ([...(body.egress ?? []), ...(body.ingress ?? [])].some((rule: any) => !['enabled', 'disabled', 'logged'].includes(rule.state))) {
            return { type: 'error', error_code: 400, error: 'Invalid egress rule 0: State must be one of: enabled, disabled, logged' };
          }
          acls[body.name] = structuredClone(body); return ok({});
        }
        if (url.startsWith('/1.0/network-acls/')) {
          const name = url.split('/').pop()!;
          if (method === 'DELETE') { delete acls[name]; return ok({}); }
          if (method === 'PUT') acls[name] = structuredClone(body);
          return acls[name] ? ok(acls[name]) : { type: 'error', error_code: 404 };
        }
        const name = url.split('/')[3];
        if (instances[name]) {
          if (method === 'PATCH' || method === 'PUT') instances[name].devices = structuredClone(body.devices);
          return ok({ ...instances[name], expanded_devices: instances[name].devices });
        }
        return { type: 'error', error_code: 404, error: 'Instance not found' };
      },
      execShell: async (container: string, script: string) => { execs.push(`${container}: ${script}`); return { exitCode: 0, stdout: '', stderr: '' }; },
    },
    './app-network-caddy-nic': caddy,
    './connection-nic': connectionNic,
    './container-ip': {
      getContainerIP: async () => null,
      hostSideNICAddress: async (name: string, iface: string, opts: { allowStopped?: boolean } = {}) => {
        addressLookups.push({ name, iface, ...opts });
        return name === 'app-prowlarr' ? { ...target } : null;
      },
    },
    'fs/promises': { readFile: async (p: string) => p.endsWith('route') ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' : '{}' },
    'yaml': { parse: JSON.parse },
    './app-network-ipam': {
      ...ipam,
      getAppNetworkLease: async (appId: string) => (appId === 'prowlarr' ? lease : null),
      readIpamState: async () => ({ leases: [lease] }),
      parseCIDR: () => ({ prefix: 27 }),
      cidrUsableAddresses: () => 30,
    },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/incus/app-network.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, structuredClone, process: { env: {} }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    require(name: string) { if (name in mocks) return mocks[name]; if (['crypto', 'path', 'node:async_hooks'].includes(name)) return require(name); return {}; },
  });
  return { exports, acls, instances, writes, execs, target, addressLookups };
}

test('revoking a connection whose source container is already deleted still removes its ACL', async () => {
  const f = fixture({ sourceExists: false });
  f.acls['ye-grant-app-sonarr-to-prowlarr'] = { name: 'ye-grant-app-sonarr-to-prowlarr', egress: [] };
  await f.exports.revokeBridgeAccess('app-sonarr', 'prowlarr');
  assert.equal(f.acls['ye-grant-app-sonarr-to-prowlarr'], undefined);
  assert.deepEqual(f.writes, ['DELETE /1.0/network-acls/ye-grant-app-sonarr-to-prowlarr']);
});

test('revoking a connection on a running source removes its NIC, then the ACL', async () => {
  const f = fixture({ sourceExists: true });
  f.instances['app-sonarr'].devices['net-prowlarr'] = { type: 'nic', network: 'yeapp1', name: 'eth-prowlarr' };
  f.acls['ye-grant-app-sonarr-to-prowlarr'] = { name: 'ye-grant-app-sonarr-to-prowlarr', egress: [] };
  await f.exports.revokeBridgeAccess('app-sonarr', 'prowlarr');
  assert.equal(f.instances['app-sonarr'].devices['net-prowlarr'], undefined);
  assert.equal(f.instances['app-sonarr'].devices.eth0.network, 'yeapp3');
  assert.equal(f.acls['ye-grant-app-sonarr-to-prowlarr'], undefined);
});

test('granting a connection allows only the target\'s main container, both ways, and brings the NIC up without systemd tools', async () => {
  const f = fixture({ sourceExists: true });
  await f.exports.grantBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr');
  const acl = f.acls['ye-grant-app-sonarr-to-prowlarr'];
  assert.ok(acl, 'integration ACL created');
  assert.deepEqual(acl.egress.map((rule: any) => [rule.action, rule.state, rule.destination]), [['allow', 'enabled', '10.76.0.5/32']]);
  // The target calls the consumer back on this NIC (Prowlarr → Sonarr); nobody else on its network may.
  assert.deepEqual(acl.ingress.map((rule: any) => [rule.action, rule.state, rule.source]), [['allow', 'enabled', '10.76.0.5/32']]);
  const nic = f.instances['app-sonarr'].devices['net-prowlarr'];
  const ifName = connectionNic.connectionInterface('prowlarr');
  assert.equal(nic.name, ifName);
  assert.equal(nic['security.acls'], 'ye-grant-app-sonarr-to-prowlarr');
  assert.equal(nic['security.acls.default.egress.action'], 'reject');
  assert.equal(nic['security.acls.default.ingress.action'], 'reject');
  const [activation, dns] = f.execs;
  assert.match(activation, /udhcpc -i "\$IF" -s "\$HOOK"/);
  assert.ok(activation.includes(`else ip link set ${ifName} up && dhclient ${ifName}; fi`));
  assert.match(dns, /command -v resolvectl >\/dev\/null 2>&1 \|\| exit 0/);
});

test('a connection is refused unless the target\'s host-side address is a host on its own network', async () => {
  for (const [address, network, refusal] of [
    ['10.76.0.1', 'yeapp1', /gateway/],
    ['10.0.3.10', 'yeapp1', /outside the app network/],
    ['10.76.0.5', 'yeapp9', /not on prowlarr's network/],
  ] as const) {
    const f = fixture({ sourceExists: true, targetAddress: address, targetNetwork: network });
    await assert.rejects(f.exports.grantBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr'), refusal);
    assert.equal(f.instances['app-sonarr'].devices['net-prowlarr'], undefined);
  }
});

test('a connection to a stopped target uses its reserved address', async () => {
  const f = fixture({ sourceExists: true });
  await f.exports.grantBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr');
  assert.deepEqual(f.addressLookups, [{ name: 'app-prowlarr', iface: 'eth0', allowStopped: true }]);
});

test('a refresh points an existing connection at the target\'s new address, and never creates one', async () => {
  const f = fixture({ sourceExists: true });
  assert.equal(await f.exports.refreshBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr'), false);
  assert.equal(f.acls['ye-grant-app-sonarr-to-prowlarr'], undefined, 'no connection, no ACL');
  await f.exports.grantBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr');
  const writes = f.writes.length;
  assert.equal(await f.exports.refreshBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr'), false);
  assert.equal(f.writes.length, writes, 'an unchanged address writes nothing');
  f.target.address = '10.76.0.9';
  assert.equal(await f.exports.refreshBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr'), true);
  const acl = f.acls['ye-grant-app-sonarr-to-prowlarr'];
  assert.deepEqual(acl.egress.map((rule: any) => rule.destination), ['10.76.0.9/32']);
  assert.deepEqual(acl.ingress.map((rule: any) => rule.source), ['10.76.0.9/32']);
  f.target.address = '10.76.0.1';
  assert.equal(await f.exports.refreshBridgeAccess('app-sonarr', 'prowlarr', 'app-prowlarr'), false, 'an unchecked address is never granted');
  assert.deepEqual(f.acls['ye-grant-app-sonarr-to-prowlarr'].egress.map((rule: any) => rule.destination), ['10.76.0.9/32']);
});

test('connection interface names are distinct for ids sharing their first 11 characters, and fit Linux', () => {
  const a = connectionInterface('paperless-ngx');
  const b = connectionInterface('paperless-ng-ai');
  assert.notEqual(a, b);
  for (const name of [a, b]) assert.match(name, /^eth-[0-9a-f]{11}$/);
  assert.equal(connectionInterface('paperless-ngx'), a);
});
