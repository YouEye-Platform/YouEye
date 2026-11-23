import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { sameConnectionProjection } from '../src/lib/bridges/connection-projection';

function load(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, console, process: { env: {} }, ...globals, require: (name: string) => mocks[name] ?? {},
  });
  return exports;
}

test('health storage persists actual transitions and debounce removal, but not unchanged resolutions', async () => {
  let stored: any = { issues: {}, debounce: {} }; let writes = 0;
  const api = load('src/lib/health/issues.ts', {
    '@/lib/health/issue-store': {
      readHealthRegistry: async () => structuredClone(stored),
      writeHealthRegistry: async (data: unknown) => { writes++; stored = structuredClone(data); },
    },
  });
  await api.resolveIssue('missing'); assert.equal(writes, 0);
  await api.observeIssue({ id: 'fixture', severity: 'error', source: 'test', title: 'Drift', body: 'Observed', debounce: 1 });
  assert.equal(writes, 1);
  await api.resolveIssue('fixture'); assert.equal(writes, 2); assert.equal(stored.issues.fixture.state, 'resolved');
  await api.resolveIssue('fixture'); assert.equal(writes, 2);
  stored.debounce.waiting = { count: 1, lastSeen: '2026-01-01' };
  await api.resolveIssue('waiting'); assert.equal(writes, 3); assert.equal(stored.debounce.waiting, undefined);
});

test('real connection projection skips unchanged posts and repairs observed drift', async () => {
  const requests: any[] = [];
  const api = load('src/lib/bridges/manager.ts', {
    './store': { getBridgesForApp: async () => [] },
    './internet-store': { listInternetGrants: async () => [] },
    '../market/catalog': { fetchManifest: async () => ({}) },
    '../market/metadata': { listInstalledApps: async () => [] },
    '../incus/container-ip': { getContainerIP: async () => '192.0.2.10' },
    'fs/promises': { readFile: async () => 'fixture-token' },
    './connection-projection': { sameConnectionProjection },
  }, {
    fetch: async (_url: string, request: any) => {
      assert.equal(request.headers['X-UI-Bridge-Token'], 'fixture-token');
      requests.push(JSON.parse(request.body)); return { ok: true };
    },
  });
  await api.pushConnectionsToUI('example', { required: true }); assert.equal(requests.length, 1);
  const { appId: _id, ...projection } = requests[0];
  await api.pushConnectionsToUI('example', { required: true, observed: { updatedAt: 'old', ...projection } });
  assert.equal(requests.length, 1);
  await assert.rejects(api.pushConnectionsToUI('example', { auditOnly: true, observed: { ...projection, internet: { granted: true } } }));
  assert.equal(requests.length, 1, 'a drifted read-only projection cannot POST before admission');
  await api.pushConnectionsToUI('example', { required: true, observed: { ...projection, internet: { granted: true } } });
  assert.equal(requests.length, 2);
  // A missing next-pass row never inherits a previous process-local success.
  await api.pushConnectionsToUI('example', { required: true, observed: null }); assert.equal(requests.length, 3);
});

test('projection comparison preserves transport authority and ignores only timestamp and key ordering', () => {
  const desired = { bridges: [{ transport: { address: '192.0.2.1', hostname: 'example.test', ca: 'public-ca-a' } }], available: [], internet: { granted: false, proxy: undefined } };
  assert.equal(sameConnectionProjection(JSON.parse(JSON.stringify({ updatedAt: 'old', ...desired })), desired), true);
  const changed = structuredClone(desired); changed.bridges[0].transport.ca = 'public-ca-b';
  assert.equal(sameConnectionProjection(changed, desired), false);
  assert.equal(sameConnectionProjection({ ...desired, unexpected: true }, desired), false);
});

// ─── YE-132 Part A: a connection is projected onto its consumer, and onto the provider only both-ways by network ───

type FixtureBridge = {
  id: string; from: string; to: string; direction: 'one-way' | 'both-ways'; active: boolean;
  accessMode?: 'network' | 'proxy' | 'caddy'; url?: string; envMappings: unknown[];
  approved: boolean; approvedBy: string; approvedAt: string; allowedPaths?: string[]; allowedMethods?: string[];
};

function bridge(from: string, to: string, fields: Partial<FixtureBridge> = {}): FixtureBridge {
  return {
    id: `${from}-to-${to}`, from, to, direction: 'one-way', active: true, envMappings: [],
    approved: true, approvedBy: 'admin', approvedAt: '2026-11-22T11:31:00Z', ...fields,
  };
}

/** The real `manager.ts`: every dependency replaced; one store of connections, one UI row map, one ACL log. */
function connections(initial: FixtureBridge[], options: { download?: () => Promise<Buffer>; failRevoke?: boolean } = {}) {
  let bridges = structuredClone(initial);
  const posts: any[] = []; const acl: string[] = []; const warnings: string[] = [];
  const installed: Record<string, any> = {
    search: { appId: 'search', subdomain: 'search', domain: 'byka.test', containers: [{ containerName: 'app-search', port: 3000 }] },
    searxng: { appId: 'searxng', subdomain: 'searxng', domain: 'byka.test', containers: [{ containerName: 'app-searxng', port: 8080 }] },
  };
  const ips: Record<string, string> = {
    'youeye-ui': '10.10.0.2', 'youeye-caddy': '10.10.0.3', 'app-search': '10.20.0.5', 'app-searxng': '10.21.0.5',
  };
  const chain = (error: any): string => error ? `${error.message}${error.cause ? ` <cause> ${chain(error.cause)}` : ''}` : '';
  const api = load('src/lib/bridges/manager.ts', {
    './store': {
      loadBridges: async () => structuredClone(bridges),
      getBridgesForApp: async (appId: string) => structuredClone(bridges.filter(b => b.from === appId || b.to === appId)),
      getBridge: async (id: string) => structuredClone(bridges.find(b => b.id === id) ?? null),
      updateBridge: async (id: string, updates: Partial<FixtureBridge>) => {
        bridges = bridges.map(b => b.id === id ? { ...b, ...updates } : b);
        return structuredClone(bridges.find(b => b.id === id) ?? null);
      },
    },
    './internet-store': { listInternetGrants: async () => [] },
    '../market/metadata': {
      readInstallMetadata: async (appId: string) => installed[appId] ?? null,
      listInstalledApps: async () => Object.values(installed),
    },
    '../market/frozen-manifest': { readInstalledAppManifest: async () => { throw new Error('no manifest in this fixture'); } },
    '../incus/container-ip': { getContainerIP: async (name: string) => ips[name] },
    '../incus/server': { incusDownloadFile: options.download ?? (async () => Buffer.from('fixture-ca')) },
    '../incus/app-network': {
      withAppNetworkOperationLock: (_lock: string, _operation: string, work: () => Promise<unknown>) => work(),
      grantBridgeAccess: async (container: string, target: string) => { acl.push(`grant ${container} -> ${target}`); },
      revokeBridgeAccess: async (container: string, target: string) => {
        acl.push(`revoke ${container} -> ${target}`);
        if (options.failRevoke) throw new Error('integration ACL delete failed');
      },
    },
    '../market/update-admission': { withAppLifecycle: (_appId: string, work: () => Promise<unknown>) => work() },
    '../../../../shared/managed-proxy': {
      managedProxyTransport: (value: any, url: string) => ({ schema: value.schema, address: value.address, hostname: value.hostname, ca: value.ca, url }),
    },
    '../market/install-tracker': { describeErrorChainForLog: chain },
    '../market/wire-runner': { runConnectionWiring: async () => {} },
    'fs/promises': { readFile: async () => 'fixture-token' },
    './connection-projection': { sameConnectionProjection },
  }, {
    fetch: async (_url: string, request: any) => { posts.push(JSON.parse(request.body)); return { ok: true }; },
    console: { ...console, warn: (line: string) => warnings.push(line) },
  });
  /** The stored row a UI would hold if it equals what was just posted for `appId`. */
  const observed = (bridgesProjected: unknown[]) => ({
    updatedAt: '2026-11-22T22:50:00Z', bridges: bridgesProjected,
    internet: { granted: false, hosts: [], proxy: [] }, available: [],
  });
  return { api, posts, acl, warnings, observed, bridges: () => bridges };
}

const searchToSearxng = bridge('search', 'searxng', { accessMode: 'proxy', url: 'https://searxng.byka.test', allowedPaths: ['/search'], allowedMethods: ['GET'] });

test('(1) one-way proxy: the provider audit with an empty row passes and posts nothing', async () => {
  const f = connections([searchToSearxng]);
  await f.api.pushConnectionsToUI('searxng', { required: true, auditOnly: true, observed: f.observed([]) });
  assert.equal(f.posts.length, 0);
});

test('(2) one-way proxy: the consumer gets one entry with its managed-proxy transport', async () => {
  const f = connections([searchToSearxng]);
  await f.api.pushConnectionsToUI('search', { required: true });
  assert.equal(f.posts.length, 1);
  const [entry, ...rest] = f.posts[0].bridges;
  assert.equal(rest.length, 0);
  assert.equal(entry.appId, 'searxng');
  assert.equal(entry.url, 'https://searxng.byka.test');
  assert.deepEqual(entry.transport, {
    schema: 'youeye.managed-proxy.v1', address: '10.10.0.3', hostname: 'searxng.byka.test', ca: 'fixture-ca', url: 'https://searxng.byka.test',
  });
});

test('(3) both-ways network: the provider side lists the consumer by host and port, without url or transport', async () => {
  const f = connections([bridge('search', 'searxng', { accessMode: 'network', direction: 'both-ways' })]);
  await f.api.pushConnectionsToUI('searxng', { required: true });
  assert.deepEqual(f.posts[0].bridges, [{
    appId: 'search', name: 'search', host: '10.20.0.5', port: 3000, accessMode: 'network', direction: 'both-ways', active: true,
  }]);
  // The row this writes reads back as unchanged on the next pass (no rewrite every 30 s).
  await f.api.pushConnectionsToUI('searxng', { required: true, auditOnly: true, observed: f.observed(f.posts[0].bridges) });
  assert.equal(f.posts.length, 1);
});

test('(4) one-way network: the provider side has no entry and a stale reverse row is repaired to none', async () => {
  const f = connections([bridge('search', 'searxng', { accessMode: 'network' })]);
  const stale = [{ appId: 'search', name: 'search', host: '10.20.0.5', port: 3000, accessMode: 'network', direction: 'one-way', active: true }];
  await assert.rejects(
    f.api.pushConnectionsToUI('searxng', { required: true, auditOnly: true, observed: f.observed(stale) }),
    f.api.UIProjectionDriftError,
  );
  assert.equal(f.posts.length, 0, 'the audit never writes');
  await f.api.pushConnectionsToUI('searxng', { required: true, observed: f.observed(stale) });
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.posts[0].bridges, []);
});

test('(5) both-ways proxy: the provider side is empty and nothing throws', async () => {
  const f = connections([{ ...searchToSearxng, direction: 'both-ways' }]);
  await f.api.pushConnectionsToUI('searxng', { required: true, auditOnly: true, observed: f.observed([]) });
  await f.api.pushConnectionsToUI('searxng', { required: true });
  assert.deepEqual(f.posts.map(post => post.bridges), [[]]);
});

test('(6) an inner failure keeps the public message and carries the real cause', async () => {
  const f = connections([searchToSearxng], { download: async () => { throw new Error('caddy root.crt unreadable'); } });
  const error: any = await f.api.pushConnectionsToUI('search', { required: true }).catch((e: unknown) => e);
  assert.equal(error.message, 'Current UI connection projection could not be verified');
  assert.equal(error.cause.message, 'caddy root.crt unreadable');
  // A hostname mismatch names the connection and its target.
  const g = connections([{ ...searchToSearxng, url: 'https://elsewhere.byka.test' }]);
  const mismatch: any = await g.api.pushConnectionsToUI('search', { required: true }).catch((e: unknown) => e);
  assert.match(mismatch.cause.message, /search-to-searxng .*searxng/);
  // The non-fatal path logs the cause instead of dropping it.
  await f.api.pushConnectionsToUI('search');
  assert.match(f.warnings.join('\n'), /Failed to push connections to UI for search: caddy root\.crt unreadable/);
});

test('direction change on an active network connection grants or revokes the reverse ACL and pushes both sides', async () => {
  const f = connections([bridge('search', 'searxng', { accessMode: 'network' })]);
  const both = await f.api.setBridgeDirection('search-to-searxng', 'both-ways');
  assert.equal(both.direction, 'both-ways');
  assert.deepEqual(f.acl, ['grant app-searxng -> search']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.map(post => post.appId).sort(), ['search', 'searxng']);
  assert.equal(f.posts.find(post => post.appId === 'searxng').bridges.length, 1);

  f.posts.length = 0;
  await f.api.setBridgeDirection('search-to-searxng', 'one-way');
  assert.deepEqual(f.acl, ['grant app-searxng -> search', 'revoke app-searxng -> search']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.find(post => post.appId === 'searxng').bridges, []);
});

test('direction change on a scoped-proxy or inactive connection changes only the record', async () => {
  const f = connections([searchToSearxng, bridge('notes', 'searxng', { accessMode: 'network', active: false })]);
  assert.equal((await f.api.setBridgeDirection('search-to-searxng', 'both-ways')).direction, 'both-ways');
  assert.equal((await f.api.setBridgeDirection('notes-to-searxng', 'both-ways')).direction, 'both-ways');
  assert.deepEqual(f.acl, []);
  assert.equal(await f.api.setBridgeDirection('missing-to-searxng', 'both-ways'), null);
});

test('direction change keeps a reverse grant another connection uses, and deactivation keeps it too', async () => {
  // searxng-to-search uses the same NIC and ACL (app-searxng may reach search) as the reverse of search-to-searxng.
  const f = connections([
    bridge('search', 'searxng', { accessMode: 'network', direction: 'both-ways' }),
    bridge('searxng', 'search', { accessMode: 'network' }),
  ]);
  assert.equal((await f.api.setBridgeDirection('search-to-searxng', 'one-way')).direction, 'one-way');
  assert.deepEqual(f.acl, [], 'the grant searxng-to-search needs is not revoked');
  await f.api.setBridgeDirection('search-to-searxng', 'both-ways');
  assert.deepEqual(f.acl, []);
  await f.api.deactivateBridge('search-to-searxng');
  assert.deepEqual(f.acl, ['revoke app-search -> searxng'], 'only the forward grant nothing else needs is revoked');
});

test('a failed revoke during a direction change restores the grant and leaves the record unchanged', async () => {
  const f = connections([bridge('search', 'searxng', { accessMode: 'network', direction: 'both-ways' })], { failRevoke: true });
  const error: any = await f.api.setBridgeDirection('search-to-searxng', 'one-way').catch((e: unknown) => e);
  assert.match(error.message, /Changing the direction of search-to-searxng failed/);
  assert.equal(error.cause.message, 'integration ACL delete failed');
  assert.deepEqual(f.acl, ['revoke app-searxng -> search', 'grant app-searxng -> search']);
  assert.equal(f.bridges()[0].direction, 'both-ways');
});

test('PATCH /api/bridges/:id with a direction goes through the manager, never straight to the store', async () => {
  const calls: string[] = [];
  const route = load('src/app/api/bridges/[bridgeId]/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/http/lifecycle-busy': { userOperationResponse: (_label: string, work: () => Promise<unknown>) => work() },
    '@/lib/auth/rbac': { requireAdminCsrf: async () => ({}), requireAdmin: async () => ({}) },
    '@/lib/bridges/store': {
      getBridge: async () => null,
      updateBridge: async () => { calls.push('store.updateBridge'); return null; },
    },
    '@/lib/bridges/manager': {
      activateBridge: async () => null, deactivateBridge: async () => null, deleteBridge: async () => false,
      setBridgeDirection: async (id: string, direction: string) => {
        calls.push(`setBridgeDirection ${id} ${direction}`);
        return id === 'search-to-searxng' ? { id, direction, active: true } : null;
      },
    },
  });
  const patch = (id: string, body: unknown) => route.PATCH(
    { json: async () => body }, { params: Promise.resolve({ bridgeId: id }) },
  );
  const ok = await patch('search-to-searxng', { direction: 'both-ways' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bridge.direction, 'both-ways');
  assert.equal((await patch('missing-to-searxng', { direction: 'one-way' })).status, 404);
  assert.equal((await patch('search-to-searxng', { direction: 'sideways' })).status, 400);
  assert.deepEqual(calls, ['setBridgeDirection search-to-searxng both-ways', 'setBridgeDirection missing-to-searxng one-way']);
});
