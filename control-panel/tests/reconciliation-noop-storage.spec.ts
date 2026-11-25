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
function connections(initial: FixtureBridge[], options: {
  download?: () => Promise<Buffer>; failRevoke?: boolean;
  /** The wire runner's answer for one connection (default: nothing to run). */
  wire?: (from: string, to: string, wireOptions?: { remove?: boolean; deadlineMs?: number }) => Promise<{ ran: boolean; error?: string }>;
  /** Apps whose lifecycle lock is held by another operation (it fails at once, as the real one does). */
  busy?: string[];
  /** Apps this process holds right now (`isAppHeld`), e.g. a start inside its own hold; the test may change it. */
  held?: string[];
  /** Running instances for the periodic pass (absent: the listing fails, nothing is filtered). */
  running?: string[];
  /** Called as a network operation lock is taken (e.g. to stop an app while a pass waits for its locks). */
  onLock?: (lock: string) => void;
} = {}) {
  let bridges = structuredClone(initial);
  let runningNow = options.running ? [...options.running] : undefined;
  const deadlines: Array<number | undefined> = [];
  const posts: any[] = []; const acl: string[] = []; const warnings: string[] = []; const wired: string[] = [];
  const locks: string[] = []; const errors: string[] = [];
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
      removeBridge: async (id: string) => {
        const before = bridges.length;
        bridges = bridges.filter(b => b.id !== id);
        return bridges.length < before;
      },
    },
    './internet-store': { listInternetGrants: async () => [] },
    '../market/metadata': {
      readInstallMetadata: async (appId: string) => installed[appId] ?? null,
      listInstalledApps: async () => Object.values(installed),
    },
    '../market/frozen-manifest': { readInstalledAppManifest: async () => { throw new Error('no manifest in this fixture'); } },
    '../incus/container-ip': { getContainerIP: async (name: string) => ips[name] },
    '../incus/server': {
      incusDownloadFile: options.download ?? (async () => Buffer.from('fixture-ca')),
      incusRequest: async (_method: string, route: string) => {
        if (!runningNow || !route.startsWith('/1.0/instances')) throw new Error('no instance listing in this fixture');
        const state = /^\/1\.0\/instances\/([^/]+)\/state$/.exec(route);
        if (state) return { type: 'sync', metadata: { status: runningNow.includes(decodeURIComponent(state[1])) ? 'Running' : 'Stopped' } };
        return { type: 'sync', metadata: runningNow.map((name) => ({ name, status: 'Running' })) };
      },
    },
    '../incus/app-network': {
      withAppNetworkOperationLock: async (lock: string, _operation: string, work: () => Promise<unknown>) => {
        options.onLock?.(lock);
        locks.push(`+${lock}`);
        try { return await work(); } finally { locks.push(`-${lock}`); }
      },
      grantBridgeAccess: async (container: string, target: string) => { acl.push(`grant ${container} -> ${target}`); },
      revokeBridgeAccess: async (container: string, target: string) => {
        acl.push(`revoke ${container} -> ${target}`);
        if (options.failRevoke) throw new Error('integration ACL delete failed');
      },
    },
    '../market/update-admission': {
      isAppHeld: (appId: string) => (options.held ?? []).includes(appId),
      withAppLifecycle: async (appId: string, work: () => Promise<unknown>) => {
        if (options.busy?.includes(appId)) {
          const error = new Error(`app-${appId} executor lock is busy`);
          error.name = 'AppLifecycleBusyError';
          throw error;
        }
        locks.push(`+${appId}`);
        try { return await work(); } finally { locks.push(`-${appId}`); }
      },
    },
    '../../../../shared/managed-proxy': {
      managedProxyTransport: (value: any, url: string) => ({ schema: value.schema, address: value.address, hostname: value.hostname, ca: value.ca, url }),
    },
    '../market/install-tracker': { describeErrorChainForLog: chain },
    '../market/wire-runner': {
      runConnectionWiring: async (from: string, to: string, _deps: unknown, wireOptions?: { remove?: boolean; leaving?: string; deadlineMs?: number }) => {
        if (!wireOptions?.remove) deadlines.push(wireOptions?.deadlineMs);
        wired.push(`${wireOptions?.remove ? 'unwire' : 'wire'} ${from} -> ${to}${wireOptions?.leaving ? ` (leaving ${wireOptions.leaving})` : ''}`);
        locks.push(`wire ${from} -> ${to}`);
        return options.wire ? options.wire(from, to, wireOptions) : { ran: false };
      },
    },
    'fs/promises': { readFile: async () => 'fixture-token' },
    './connection-projection': { sameConnectionProjection },
  }, {
    fetch: async (_url: string, request: any) => { posts.push(JSON.parse(request.body)); return { ok: true }; },
    console: { ...console, warn: (line: string) => warnings.push(line), error: (line: string) => errors.push(line) },
  });
  /** The stored row a UI would hold if it equals what was just posted for `appId`. */
  const observed = (bridgesProjected: unknown[]) => ({
    updatedAt: '2026-11-22T22:50:00Z', bridges: bridgesProjected,
    internet: { granted: false, hosts: [], proxy: [] }, available: [],
  });
  return { api, posts, acl, warnings, errors, wired, locks, observed, deadlines, bridges: () => bridges,
    setBridges: (next: FixtureBridge[]) => { bridges = structuredClone(next); },
    setRunning: (next: string[]) => { runningNow = [...next]; } };
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

test('an uninstall that did not complete marks the app\'s active network connections for re-wiring (YE-209)', async () => {
  const f = connections([
    bridge('sonarr', 'sabnzbd', { accessMode: 'network' }),
    bridge('sabnzbd', 'search', { accessMode: 'network', direction: 'both-ways' }),
    bridge('notes', 'sabnzbd', { accessMode: 'network', active: false }),
    bridge('lidarr', 'sabnzbd', { accessMode: 'proxy', url: 'https://sabnzbd.byka.test' }),
    bridge('search', 'searxng', { accessMode: 'network' }),
  ]);
  const marked = await f.api.markConnectionsForRewire('sabnzbd');
  // Both ways; a waiting connection was never wired, a scoped-proxy one has no connect file, another app's is not touched.
  assert.deepEqual([...marked], ['sonarr-to-sabnzbd', 'sabnzbd-to-search']);
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending).map((b: any) => b.id), ['sonarr-to-sabnzbd', 'sabnzbd-to-search']);
  assert.ok(f.bridges().every((b: any) => b.active || b.id === 'notes-to-sabnzbd'), 'the records stay active');
  assert.deepEqual(f.wired, [], 'marking runs nothing');
});

test('a pass wires a marked connection again and clears the mark; a failed wiring keeps it and backs off (YE-209, YE-223)', async () => {
  let peerUp = false;
  let clock = 1_000_000;
  const now = () => clock;
  const f = connections([
    bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>),
    bridge('sabnzbd', 'search', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>),
    bridge('notes', 'sabnzbd', { accessMode: 'network', active: false, rewirePending: true } as Partial<FixtureBridge>),
    bridge('radarr', 'sabnzbd', { accessMode: 'network' }),
  ], { wire: async (from, to) => from === 'sabnzbd' && !peerUp ? { ran: false, error: `Could not wire ${from} → ${to}` } : { ran: true } });
  // search does not answer: its connection stays marked; the inactive one only loses its mark; an unmarked one is not run.
  assert.deepEqual([...await f.api.rewirePendingConnections('sabnzbd', now)], ['sabnzbd-to-search']);
  assert.deepEqual(f.wired, ['wire sonarr -> sabnzbd', 'wire sabnzbd -> search']);
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending).map((b: any) => b.id), ['sabnzbd-to-search']);
  // The next pass, 10 s later, does not try it again (back-off), even with search up.
  peerUp = true;
  clock += 10_000;
  assert.deepEqual([...await f.api.rewirePendingConnections(undefined, now)], ['sabnzbd-to-search']);
  assert.equal(f.wired.length, 2);
  // search's start brings it forward: the next pass wires it and clears the mark.
  f.api.requestRewire('search');
  assert.deepEqual([...await f.api.rewirePendingConnections(undefined, now)], []);
  assert.deepEqual(f.wired.slice(2), ['wire sabnzbd -> search']);
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending), []);
  assert.deepEqual([...await f.api.rewirePendingConnections(undefined, now)], []);
  assert.equal(f.wired.length, 3, 'nothing marked, nothing run');
});

test('re-wiring holds both apps\' lifecycle locks and the bridge lock, and clears the mark inside them (YE-218)', async () => {
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => ({ ran: true }) });
  assert.deepEqual([...await f.api.rewirePendingConnections('sabnzbd')], []);
  // Sorted app locks (the same order as activation and unwiring), then the bridge lock, the wiring inside all three.
  assert.deepEqual(f.locks, ['+sabnzbd', '+sonarr', '+bridge-lifecycle', 'wire sonarr -> sabnzbd', '-bridge-lifecycle', '-sonarr', '-sabnzbd']);
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending), []);
});

test('a busy peer (its retried uninstall or update rollback runs) is not re-wired now; the mark stays, quietly (YE-218)', async () => {
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => ({ ran: true }), busy: ['sonarr'] });
  assert.deepEqual([...await f.api.rewirePendingConnections('sabnzbd')], ['sonarr-to-sabnzbd']);
  assert.deepEqual(f.wired, [], 'nothing runs against an app another operation holds');
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending).map((b: any) => b.id), ['sonarr-to-sabnzbd']);
  assert.deepEqual(f.errors, [], 'busy is not an error: the next start or pass retries');
});

test('the mark is read again inside the locks and cleared only while it is still the same connection (YE-218)', async () => {
  const marked = bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>);
  // (a) Gone by the time the locks are held (a peer's uninstall deleted it): nothing runs, nothing is written.
  let f = connections([marked], { wire: async () => ({ ran: true }) });
  const read = f.api.rewirePendingConnections('sabnzbd');
  f.setBridges([]);
  assert.deepEqual([...await read], []);
  assert.deepEqual(f.wired, []);
  // (b) Replaced while the connect file ran (another connection now holds the id): its mark is not cleared.
  let swap = () => {};
  f = connections([marked], { wire: async () => { swap(); return { ran: true }; } });
  swap = () => f.setBridges([{ ...marked, from: 'radarr' }]);
  await f.api.rewirePendingConnections('sabnzbd');
  assert.equal(f.bridges()[0].rewirePending, true, 'compare and clear: the new connection keeps its mark');
});

test('the periodic pass wires marked connections whose two apps run (Incus autostart, an app left running) (YE-218)', async () => {
  const f = connections([
    bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>),
    bridge('sabnzbd', 'search', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>),
    bridge('radarr', 'sabnzbd', { accessMode: 'network' }),
  ], { wire: async () => ({ ran: true }), running: ['app-sonarr', 'app-sabnzbd'] });
  // No app started: the pass (no app id) wires the one whose apps both run; search is stopped, so its stays marked.
  assert.deepEqual([...await f.api.rewirePendingConnections()], ['sabnzbd-to-search']);
  assert.deepEqual(f.wired, ['wire sonarr -> sabnzbd']);
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending).map((b: any) => b.id), ['sabnzbd-to-search']);
  // The reconcile pass starts it after refreshing the grants, and does not wait for it (YE-223).
  const reconciler = readFileSync('src/lib/market/reconciler.ts', 'utf8');
  assert.match(reconciler, /refreshConnectionGrants\(\)\) unresolved\.push[^\n]*\n[\s\S]{0,400}void startRewirePass\(\);/);
  assert.doesNotMatch(reconciler, /await (startRewirePass|rewirePendingConnections)\(/);
});

test('a start and a restart bring marked connections forward without waiting; the bridge store accepts the mark (YE-209, YE-223)', () => {
  const lifecycle = readFileSync('src/lib/apps/lifecycle.ts', 'utf8');
  const start = lifecycle.slice(lifecycle.indexOf("if (action === 'start')"), lifecycle.indexOf("if (action === 'restart')"));
  assert.match(start, /refreshConnectionGrants\(meta\.appId\);\s*requestRewire\(meta\.appId\);/);
  const restart = lifecycle.slice(lifecycle.indexOf("if (action === 'restart')"));
  assert.match(restart, /requestRewire\(meta\.appId\)/);
  // No wiring, and no wait for a peer's lock, inside a user's start or restart.
  assert.doesNotMatch(lifecycle, /rewirePendingConnections|startRewirePass/);
  const store = readFileSync('src/lib/bridges/store.ts', 'utf8');
  assert.match(store, /bridge\.rewirePending !== undefined && typeof bridge\.rewirePending !== 'boolean'/);
});

test('the re-wiring is bounded: the connect file gets REWIRE_LIMIT_MS (20 s) for all its steps (YE-223)', async () => {
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => ({ ran: true }) });
  assert.equal(f.api.REWIRE_LIMIT_MS, 20_000);
  await f.api.rewirePendingConnections();
  assert.deepEqual(f.deadlines, [20_000]);
});

test('an app that stopped while the pass waited for its locks is checked again inside them: nothing runs (YE-223)', async () => {
  let stopOnLock = true;
  const f: ReturnType<typeof connections> = connections(
    [bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => ({ ran: true }), running: ['app-sonarr', 'app-sabnzbd'],
      // Both run at the listing; sabnzbd stops while the pass waits for the bridge lock.
      onLock: (lock) => { if (lock === 'bridge-lifecycle' && stopOnLock) f.setRunning(['app-sonarr']); } });
  assert.deepEqual([...await f.api.rewirePendingConnections()], ['sonarr-to-sabnzbd']);
  assert.ok(f.locks.includes('+bridge-lifecycle'), 'the check ran inside the locks');
  assert.deepEqual(f.wired, [], 'no connect file ran against a stopped app');
  assert.equal(f.bridges()[0].rewirePending, true);
  assert.deepEqual(f.warnings.filter((line: string) => /still not wired/.test(line)), [], 'a stopped app is not a failure');
  // It is not backed off: once sabnzbd runs again, the next pass wires it.
  stopOnLock = false;
  f.setRunning(['app-sonarr', 'app-sabnzbd']);
  assert.deepEqual([...await f.api.rewirePendingConnections()], []);
  assert.deepEqual(f.wired, ['wire sonarr -> sabnzbd']);
});

test('a wiring that keeps failing is tried after 30 s, 1, 2, 4… up to 30 min, one log line per try (YE-223)', async () => {
  let clock = 0;
  const now = () => clock;
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => ({ ran: false, error: 'Could not wire sonarr → sabnzbd' }) });
  const tries: number[] = [];
  // A pass every 30 s for 3 hours (the reconcile interval).
  for (clock = 0; clock <= 3 * 3600_000; clock += 30_000) {
    const before = f.wired.length;
    await f.api.rewirePendingConnections(undefined, now);
    if (f.wired.length > before) tries.push(clock / 1000);
  }
  assert.deepEqual(tries.slice(0, 7), [0, 30, 90, 210, 450, 930, 1890]);
  // Then every 30 min.
  assert.deepEqual(tries.slice(7).map((t, i) => t - tries[6 + i]), tries.slice(7).map(() => 1800));
  assert.equal(f.warnings.filter((line: string) => /still not wired again/.test(line)).length, tries.length);
  assert.equal(f.bridges()[0].rewirePending, true, 'the mark stays');
});

test('a start that asks from inside its own hold is served once the hold ends, never lost (alpha.7 review)', async () => {
  const held = ['sabnzbd'];
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => ({ ran: true }), held });
  // lifecycle.ts asks while it still holds sabnzbd: a pass now would skip it as busy and the request would be gone.
  f.api.requestRewire('sabnzbd');
  f.api.rewireWatchTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.wired.length, 0, 'no pass while the only requesting app is held');
  // The hold ends: the next look serves the kept request.
  held.length = 0;
  f.api.rewireWatchTick();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.wired.length, 1, 'served after the hold');
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending), []);
});

test('a start is served by the re-wire watch, not the reconcile round; a request during a pass waits for the next look (YE-224)', async () => {
  let release: () => void = () => {};
  let fail = true;
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: () => fail ? Promise.resolve({ ran: false, error: 'Could not wire sonarr → sabnzbd' })
      : new Promise((resolve) => { release = () => resolve({ ran: true }); }) });
  // A failed try backs off for 30 s; no request, so the watch does nothing.
  await f.api.rewirePendingConnections();
  f.api.rewireWatchTick();
  assert.equal(f.wired.length, 1);
  // sabnzbd starts: the next look of the watch starts a pass at once, back-off or not, whatever the reconcile round does.
  fail = false;
  f.api.requestRewire('sabnzbd');
  f.api.rewireWatchTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.wired.length, 2, 'the watch started a pass');
  // sonarr starts while that pass runs: kept for the next look, not swallowed by the running pass.
  f.api.requestRewire('sonarr');
  f.api.rewireWatchTick();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.bridges().filter((b: any) => b.rewirePending), []);
  f.api.rewireWatchTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.wired.length, 2, 'nothing left marked: the next pass runs nothing');
  // The watch is started by instrumentation, apart from the reconcile round (which can return early).
  const instrumentation = readFileSync('src/instrumentation.ts', 'utf8');
  assert.match(instrumentation, /const \{ startRewireWatch \} = await import\("@\/lib\/bridges\/manager"\);\s*startRewireWatch\(\);/);
  assert.equal(f.api.REWIRE_WATCH_MS, 5_000);
  // None of the round's early returns (reconfigure journal, install-operation state, unlistable app networks, a
  // probe that throws) can hold it up: the watch never goes through the reconciler or the health checker.
  const manager = readFileSync('src/lib/bridges/manager.ts', 'utf8');
  assert.doesNotMatch(manager, /from ['"][^'"]*(reconciler|health-checker|health\/issues)['"]/);
  const watch = manager.slice(manager.indexOf('export function rewireWatchTick('), manager.indexOf('export function startRewireWatch('));
  assert.match(watch, /void startRewirePass\(\);/);
});

test('a start during a failing try is not overwritten by that try\'s back-off (YE-224)', async () => {
  let clock = 0;
  const now = () => clock;
  let f: ReturnType<typeof connections>;
  let startDuringTry = false;
  f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: async () => {
      if (startDuringTry) { clock += 1_000; f.api.requestRewire('sonarr', now); }
      return { ran: false, error: 'Could not wire sonarr → sabnzbd' };
    } });
  // Three failures: the back-off is at 2 min.
  for (const at of [0, 30_000, 90_000]) { clock = at; await f.api.rewirePendingConnections(undefined, now); }
  assert.equal(f.wired.length, 3);
  // The fourth try fails while sonarr starts: no back-off from that stale count, the next pass tries again.
  clock = 210_000;
  startDuringTry = true;
  await f.api.rewirePendingConnections(undefined, now);
  startDuringTry = false;
  clock += 5_000;
  await f.api.rewirePendingConnections(undefined, now);
  assert.equal(f.wired.length, 5, 'tried again 5 s later, not after 4 min');
  assert.match(f.warnings.join('\n'), /an app of it started meanwhile/);
  // A failure after that starts counting afresh: 30 s.
  clock += 10_000;
  await f.api.rewirePendingConnections(undefined, now);
  assert.equal(f.wired.length, 5);
  clock += 25_000;
  await f.api.rewirePendingConnections(undefined, now);
  assert.equal(f.wired.length, 6);
});

test('only one re-wiring pass runs at a time; the reconcile round does not wait for it (YE-223)', async () => {
  let release: () => void = () => {};
  const f = connections([bridge('sonarr', 'sabnzbd', { accessMode: 'network', rewirePending: true } as Partial<FixtureBridge>)],
    { wire: () => new Promise((resolve) => { release = () => resolve({ ran: true }); }) });
  const first = f.api.startRewirePass();
  const second = f.api.startRewirePass();
  assert.equal(first, second, 'a pass still running is joined, not started twice');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.wired, ['wire sonarr -> sabnzbd']);
  release();
  assert.deepEqual([...await first], []);
  // Once it ended, the next round starts a new one.
  assert.notEqual(f.api.startRewirePass(), first);
});

test('an uninstall undoes every active connection of the app, both ways, and reports the ones that failed (YE-199)', async () => {
  const f = connections([
    bridge('search', 'searxng', { accessMode: 'network' }),
    bridge('searxng', 'search', { accessMode: 'network' }),
    bridge('notes', 'searxng', { accessMode: 'network', active: false }),
  ], { wire: async (from, to) => from === 'searxng' ? { ran: false, error: `Could not unwire ${from} → ${to}` } : { ran: true } });
  const failed = await f.api.unwireAppConnections('searxng');
  // The app as the connected app (search's file) and as the consumer (its own); a waiting connection was never wired.
  assert.deepEqual(f.wired, ['unwire search -> searxng (leaving searxng)', 'unwire searxng -> search (leaving searxng)']);
  // The other app's name comes from its installed manifest; without one (this fixture), its id.
  assert.deepEqual(JSON.parse(JSON.stringify(failed)), [{ appId: 'search', name: 'search',
    message: 'Could not unwire searxng → search: the remove steps of this connection did not all run; search may still list searxng' }]);
  assert.equal(f.bridges().length, 3, 'the connections themselves stay until they are deleted');
  // Deleting them afterwards does not run the steps again; a plain delete (disconnect) still does.
  assert.equal(await f.api.deleteBridge('search-to-searxng', { unwired: true }), true);
  assert.deepEqual(f.wired.length, 2);
  assert.equal(await f.api.deleteBridge('searxng-to-search'), true);
  assert.deepEqual(f.wired.slice(2), ['unwire searxng -> search']);
});

test('an error while undoing one connection is reported, and the others are still undone (YE-199)', async () => {
  const f = connections([bridge('search', 'searxng', { accessMode: 'network' }), bridge('notes', 'searxng', { accessMode: 'network' })],
    { wire: async (from) => { if (from === 'search') throw new Error('lifecycle busy'); return { ran: true }; } });
  const failed = await f.api.unwireAppConnections('searxng');
  assert.deepEqual(f.wired, ['unwire search -> searxng (leaving searxng)', 'unwire notes -> searxng (leaving searxng)']);
  assert.deepEqual([...failed.map((left: { message: string }) => left.message)],
    ['Could not unwire search → searxng: the remove steps of this connection did not all run; search may still list searxng']);
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
