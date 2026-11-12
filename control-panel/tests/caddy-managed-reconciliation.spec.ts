import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getContainerIP, hostSideNICAddress } from '../src/lib/incus/container-ip';
import { waitForIncusReady, safeIncusFailure } from '../src/lib/incus/readiness';
import { isUsableIPv4 } from '../src/lib/incus/ipv4';
import { runStartupReconciliation } from '../src/lib/incus/startup-reconciliation';
import { getConfig, setConfig, verifyManagedProxy, reconcileManagedRoutes, resolveCaddyUpstream, type ManagedRouteDependencies } from '../src/lib/caddy/client';
import type { CaddyConfig } from '../src/lib/caddy/types';
import { recordSetupRouteResult } from '../src/lib/caddy/setup-result';

async function withIncus(
  respond: (path: string) => unknown,
  run: () => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'managed-incus-'));
  const socket = join(dir, 'incus.sock');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const response = respond(req.url ?? '');
    res.end(Buffer.isBuffer(response) ? response : JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const previousSocket = process.env.INCUS_SOCKET;
  const previousHTTPS = process.env.INCUS_HTTPS_URL;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await run();
  } finally {
    if (previousSocket === undefined) delete process.env.INCUS_SOCKET;
    else process.env.INCUS_SOCKET = previousSocket;
    if (previousHTTPS === undefined) delete process.env.INCUS_HTTPS_URL;
    else process.env.INCUS_HTTPS_URL = previousHTTPS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test('readiness rejects an untrusted API and recovers when configured transport becomes trusted', async () => {
  let probes = 0;
  await withIncus(() => ({ type: 'sync', metadata: { auth: ++probes < 3 ? 'untrusted' : 'trusted' } }), async () => {
    await waitForIncusReady({ timeoutMs: 200, retryMs: 1 });
  });
  assert.equal(probes, 3);
});

test('readiness exhaustion is bounded and redacts credential-bearing errors', async () => {
  const start = Date.now();
  await assert.rejects(waitForIncusReady({ timeoutMs: 25, retryMs: 1 }, async () => {
    throw new Error('ECONNREFUSED https://user:private-password@invalid/');
  }), /readiness exhausted \(ECONNREFUSED\)/);
  assert.ok(Date.now() - start < 500);
  assert.equal(safeIncusFailure(new Error('Bearer private-token')), 'API_UNAVAILABLE_OR_INVALID_RESPONSE');
});

test('a probe that never responds cannot defeat the readiness deadline', async () => {
  await assert.rejects(
    waitForIncusReady({ timeoutMs: 20, retryMs: 1 }, () => new Promise(() => {})),
    /readiness exhausted \(TIMEOUT\)/,
  );
});

test('managed discovery never falls back to DNS when both static and live queries fail', async () => {
  let calls = 0;
  await withIncus(() => {
    calls++;
    return { type: 'error', metadata: {}, error: 'private response body' };
  }, async () => {
    await assert.rejects(resolveCaddyUpstream('youeye-control.youeye'), /IPv4 discovery failed/);
    assert.equal(calls, 2);
    assert.equal(await resolveCaddyUpstream('service.example.com'), 'service.example.com');
    await assert.rejects(resolveCaddyUpstream('YOUEYE-CONTROL.YOUEYE.'), /IPv4 discovery failed/);
    assert.equal(await resolveCaddyUpstream('10.45.18.99'), '10.45.18.99');
  });
});

function hostSideIncus(input: {
  status?: string;
  devices?: Record<string, Record<string, string>>;
  leases?: Array<{ address: string; hwaddr: string; type?: string }>;
  staticSubnet?: string;
}, paths: string[] = []) {
  return (path: string) => {
    paths.push(path);
    if (path === '/1.0/networks/incusbr0') {
      return { type: 'sync', metadata: { config: { 'ipv4.address': input.staticSubnet ?? '999.12.1.1/24' } } };
    }
    if (path.endsWith('/leases')) return { type: 'sync', metadata: input.leases ?? [] };
    if (path.endsWith('/state')) {
      // A container's own report: never consulted.
      return { type: 'sync', metadata: { network: { eth0: { addresses: [{ family: 'inet', scope: 'global', address: '10.45.18.13' }] } } } };
    }
    return { type: 'sync', metadata: {
      status: input.status ?? 'Running',
      config: { 'volatile.eth0.hwaddr': '10:66:6A:00:00:01', 'volatile.net-peer.hwaddr': '10:66:6a:00:00:02' },
      expanded_devices: input.devices ?? { eth0: { type: 'nic', network: 'yeapp1', name: 'eth0' } },
    } };
  };
}

test('an app container address comes from its NIC lease, never from what the container reports', async () => {
  const paths: string[] = [];
  await withIncus(hostSideIncus({ leases: [
    { address: '10.76.0.40', hwaddr: '10:66:6a:00:00:99' },
    { address: '10.76.0.34', hwaddr: '10:66:6a:00:00:01', type: 'dynamic' },
  ] }, paths), async () => {
    assert.equal(await getContainerIP('app-one', { required: true }), '10.76.0.34');
    assert.deepEqual(await hostSideNICAddress('app-one'), { network: 'yeapp1', address: '10.76.0.34' });
    assert.equal(await resolveCaddyUpstream('app-one.youeye'), '10.76.0.34');
  });
  assert.equal(paths.some((path) => path.endsWith('/state')), false);
  assert.ok(paths.includes('/1.0/networks/yeapp1/leases'));
});

test('a fixed NIC address wins; a hot-plugged NIC is found by its interface name', async () => {
  await withIncus(hostSideIncus({ devices: {
    eth0: { type: 'nic', network: 'yeapp1', name: 'eth0', 'ipv4.address': '10.76.0.35' },
    'net-peer': { type: 'nic', network: 'yeapp2', name: 'eth-peer' },
  }, leases: [{ address: '10.76.0.66', hwaddr: '10:66:6a:00:00:02' }] }), async () => {
    assert.equal(await getContainerIP('app-one'), '10.76.0.35');
    assert.deepEqual(await hostSideNICAddress('app-one', 'eth-peer'), { network: 'yeapp2', address: '10.76.0.66' });
    assert.equal(await hostSideNICAddress('app-one', 'eth9'), null);
  });
});

test('a stopped container, a missing lease or an ambiguous lease gives no address', async () => {
  await withIncus(hostSideIncus({ status: 'Stopped', leases: [{ address: '10.76.0.34', hwaddr: '10:66:6a:00:00:01' }] }), async () => {
    assert.equal(await getContainerIP('app-one'), null);
    assert.deepEqual(await hostSideNICAddress('app-one', 'eth0', { allowStopped: true }), { network: 'yeapp1', address: '10.76.0.34' });
  });
  await withIncus(hostSideIncus({ leases: [] }), async () => {
    assert.equal(await getContainerIP('app-one'), null);
    await assert.rejects(getContainerIP('app-one', { required: true }), /IPv4 discovery failed/);
  });
  await withIncus(hostSideIncus({ leases: [
    { address: '10.76.0.34', hwaddr: '10:66:6a:00:00:01' },
    { address: '10.76.0.36', hwaddr: '10:66:6a:00:00:01' },
  ] }), async () => {
    assert.equal(await getContainerIP('app-one'), null);
  });
});

test('valid static discovery computes an installation-specific IPv4 without a live-state lookup', async () => {
  const paths: string[] = [];
  await withIncus((path) => {
    paths.push(path);
    return { type: 'sync', metadata: { config: { 'ipv4.address': '10.45.18.1/24' } } };
  }, async () => {
    assert.equal(await getContainerIP('youeye-control', { required: true }), '10.45.18.16');
  });
  assert.deepEqual(paths, ['/1.0/networks/incusbr0']);
});

test('unusable lease addresses fail strictly while optional discovery remains nullable', async () => {
  await withIncus(hostSideIncus({ leases: [{ address: '169.254.1.2', hwaddr: '10:66:6a:00:00:01' }] }), async () => {
    assert.equal(await getContainerIP('app-invalid'), null);
    await assert.rejects(getContainerIP('app-invalid', { required: true }), /IPv4 discovery failed/);
  });
  for (const value of ['999.1.1.1', '127.0.0.1', '0.0.0.0', '169.254.1.1', '::1', '224.0.0.1']) {
    assert.equal(isUsableIPv4(value), false, value);
  }
});

function fixtureConfig(): CaddyConfig {
  return {
    admin: { listen: '0.0.0.0:2019', enforce_origin: false },
    apps: { http: { servers: { srv0: {
      listen: [':443'], tls_connection_policies: [{}],
      routes: [
        { '@id': 'security-header-strip', handle: [{ handler: 'headers', request: { delete: ['X-Youeye-Username'] } }] },
        { '@id': 'api-ping-route', match: [{ path: ['/api/ping'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'youeye-control.youeye:3000' }] }] },
        { '@id': 'existing-app', match: [{ host: ['app.example.test'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.88.0.3:3000' }] }] },
        { '@id': 'owner-ordered-app', match: [{ host: ['app.example.test'], path: ['/long/specific/*'] }], handle: [{ handler: 'static_response', body: 'owner precedence' }] },
        { '@id': 'legacy-pointer', match: [{ host: ['ai.example.test'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'youeye-pointer.incus:4002' }] }] },
      ],
    } } } },
  };
}

function routeFixture() {
  let config = fixtureConfig();
  const writes: CaddyConfig[] = [];
  let verified = 0;
  const offsets: Record<string, number> = { 'youeye-control': 16, 'youeye-pointer': 17, 'youeye-ui': 15, 'youeye-pihole': 14 };
  const dependencies: ManagedRouteDependencies = {
    ready: async () => {},
    resolve: async (name, port) => `10.45.18.${offsets[name]}:${port}`,
    read: async () => structuredClone(config),
    write: async (value) => { config = structuredClone(value); writes.push(structuredClone(value)); },
    verify: async () => { verified++; },
    pointerDeployed: async () => true,
  };
  return { dependencies, writes, read: () => config, verified: () => verified };
}

test('legacy repair is atomic, preserves unrelated routes and security ordering, and verifies no-op repairs', async () => {
  const fixture = routeFixture();
  const existing = structuredClone(fixture.read().apps!.http!.servers!.srv0.routes![2]);
  await reconcileManagedRoutes('example.test', fixture.dependencies);
  assert.equal(fixture.writes.length, 1);
  const routes = fixture.read().apps!.http!.servers!.srv0.routes!;
  assert.equal(routes[0]['@id'], 'security-header-strip');
  assert.equal(routes[1]['@id'], 'api-ping-route');
  assert.deepEqual(routes.find((route) => route['@id'] === 'existing-app'), existing);
  assert.ok(routes.findIndex((route) => route['@id'] === 'existing-app') < routes.findIndex((route) => route['@id'] === 'owner-ordered-app'));
  const settings = routes.find((route) => route['@id'] === 'control-settings-route')!;
  assert.deepEqual(settings.match, [{ host: ['example.test'], path: ['/settings', '/settings/*', '/onboarding'] }]);
  const support = routes.find((route) => route['@id'] === 'control-settings-support-route')!;
  assert.ok(support.match![0].path!.includes('/api/ai-proxy-test'));
  assert.deepEqual((support.match![0] as unknown as { header: unknown }).header, {
    Referer: ['*://example.test/settings*', '*://example.test/market*', '*://example.test/onboarding*'],
  });
  const assets = routes.find((route) => route['@id'] === 'control-pointer-assets-route')!;
  assert.deepEqual(assets.match, [{ host: ['example.test'], path: ['/api/pointer-ui/*'] }]);
  assert.deepEqual(assets.handle, [{ handler: 'reverse_proxy', upstreams: [{ dial: '10.45.18.16:3000' }] }]);
  const pointer = routes.find((route) => route['@id'] === 'pointer-inference-route')!;
  assert.deepEqual(pointer.match![0].path, ['/v1', '/v1/*', '/v1beta', '/v1beta/*']);
  assert.match(JSON.stringify(routes.find((route) => route['@id'] === 'legacy-pointer')), /10\.45\.18\.17:4002/);
  assert.doesNotMatch(JSON.stringify(routes), /youeye-(control|pointer)\.(youeye|incus):/);
  await reconcileManagedRoutes('example.test', fixture.dependencies);
  assert.equal(fixture.writes.length, 1, 'repeat repair must suppress no-op write');
  assert.equal(fixture.verified(), 2, 'no-op still requires proxy acceptance');
});

test('Pointer discovery failure preserves every existing route with zero writes', async () => {
  const fixture = routeFixture();
  const before = structuredClone(fixture.read());
  await assert.rejects(reconcileManagedRoutes('example.test', {
    ...fixture.dependencies,
    resolve: async (name, port) => {
      if (name === 'youeye-pointer') throw new Error('Incus not ready');
      return fixture.dependencies.resolve(name, port);
    },
  }), /Incus not ready/);
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual(fixture.read(), before);
});

test('Control Panel routes reconcile without Pointer: no Pointer discovery, route, or /v1 probe', async () => {
  for (const options of [{ pointer: false }, {}] as const) {
    const fixture = routeFixture();
    const resolved: string[] = [];
    const verifyOptions: Array<{ pointer: boolean }> = [];
    await reconcileManagedRoutes('example.test', {
      ...fixture.dependencies,
      pointerDeployed: async () => false,
      resolve: async (name, port) => {
        resolved.push(name);
        if (name === 'youeye-pointer') throw new Error('Pointer is not deployed');
        return fixture.dependencies.resolve(name, port);
      },
      verify: async (_domain, _config, verify) => { verifyOptions.push(verify); },
    }, options);
    assert.ok(!resolved.includes('youeye-pointer'));
    assert.deepEqual(verifyOptions, [{ pointer: false }]);
    const routes = fixture.read().apps!.http!.servers!.srv0.routes!;
    assert.ok(routes.some((route) => route['@id'] === 'control-settings-route'));
    assert.ok(!routes.some((route) => route['@id'] === 'pointer-inference-route'));
    // An existing Pointer route is left as it is, not rewritten or removed.
    assert.match(JSON.stringify(routes.find((route) => route['@id'] === 'legacy-pointer')), /youeye-pointer\.incus:4002/);
  }
});

test('Pointer routes are managed when requested even if deployment detection says otherwise', async () => {
  const fixture = routeFixture();
  const verifyOptions: Array<{ pointer: boolean }> = [];
  await reconcileManagedRoutes('example.test', {
    ...fixture.dependencies,
    pointerDeployed: async () => false,
    verify: async (_domain, _config, verify) => { verifyOptions.push(verify); },
  }, { pointer: true });
  assert.deepEqual(verifyOptions, [{ pointer: true }]);
  assert.ok(fixture.read().apps!.http!.servers!.srv0.routes!.some((route) => route['@id'] === 'pointer-inference-route'));
});

test('managed DNS or invalid IP returned by discovery is rejected before writes', async () => {
  for (const host of ['youeye-control.youeye', '999.0.0.1', '127.0.0.1']) {
    const fixture = routeFixture();
    await assert.rejects(reconcileManagedRoutes('example.test', {
      ...fixture.dependencies, resolve: async (_name, port) => `${host}:${port}`,
    }), /invalid IPv4 dial/);
    assert.equal(fixture.writes.length, 0);
  }
});

test('failed proxy verification rolls back exactly and a later repair succeeds', async () => {
  const fixture = routeFixture();
  const before = structuredClone(fixture.read());
  await assert.rejects(reconcileManagedRoutes('example.test', {
    ...fixture.dependencies, verify: async () => { throw new Error('HTTP 502'); },
  }), /HTTP 502/);
  assert.equal(fixture.writes.length, 2);
  assert.deepEqual(fixture.read(), before);
  await reconcileManagedRoutes('example.test', fixture.dependencies);
  assert.equal(fixture.verified(), 1);
});

test('ambiguous successful load is reconciled and rolled back after response loss', async () => {
  const fixture = routeFixture();
  const before = structuredClone(fixture.read());
  let calls = 0;
  await assert.rejects(reconcileManagedRoutes('example.test', {
    ...fixture.dependencies,
    write: async (value) => {
      await fixture.dependencies.write(value, await fixture.dependencies.read());
      if (++calls === 1) throw new Error('lost acknowledgement');
    },
  }), /lost acknowledgement/);
  assert.deepEqual(fixture.read(), before);
});

test('unverified rollback is reported explicitly, never as repair success', async () => {
  const fixture = routeFixture();
  let writes = 0;
  await assert.rejects(reconcileManagedRoutes('example.test', {
    ...fixture.dependencies,
    write: async (value) => {
      if (++writes > 1) throw new Error('restore rejected');
      await fixture.dependencies.write(value, await fixture.dependencies.read());
    },
    verify: async () => { throw new Error('HTTP 502'); },
  }), /rollback could not be verified/);
});

test('startup waits for readiness, retries recovery, and coalesces duplicate callers', async () => {
  const calls: string[] = [];
  let probes = 0;
  const dependencies = {
    ready: async () => { calls.push('ready'); if (++probes === 1) throw new Error('ECONNREFUSED'); },
    bootstrap: async () => { calls.push('bootstrap'); },
    apps: async () => { calls.push('apps'); return { unresolved: [] }; },
    routes: async () => { calls.push('routes'); },
  };
  const first = runStartupReconciliation(dependencies, { attempts: 2, retryMs: 1 });
  const second = runStartupReconciliation(dependencies, { attempts: 2, retryMs: 1 });
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls, ['ready', 'ready', 'bootstrap', 'apps', 'routes']);
});

test('startup exhaustion is actionable and app failure does not prevent route repair', async () => {
  let routeRepairs = 0;
  await assert.rejects(runStartupReconciliation({
    ready: async () => {}, bootstrap: async () => {},
    apps: async () => { throw new Error('app divergence'); },
    routes: async () => { routeRepairs++; },
  }, { attempts: 2, retryMs: 1 }), /System Health repair/);
  assert.equal(routeRepairs, 2);
});

test('returned app divergences remain failures even when routes are repaired', async () => {
  let attempts = 0;
  await assert.rejects(runStartupReconciliation({
    ready: async () => {}, bootstrap: async () => {},
    apps: async () => ({ unresolved: ['retained-owner-app-divergence'] }),
    routes: async () => { attempts++; },
  }, { attempts: 2, retryMs: 1 }), /System Health repair/);
  assert.equal(attempts, 2);
});

async function withAdmin(
  initial: CaddyConfig,
  run: (fixture: { config: () => CaddyConfig; raceNextWrite: () => void }) => Promise<void>,
): Promise<void> {
  let config = structuredClone(initial);
  let race = false;
  const etag = () => `"${createHash('sha256').update(JSON.stringify(config)).digest('hex')}"`;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/config/') {
      res.setHeader('etag', etag());
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === 'POST' && req.url === '/config/') {
      if (race) {
        race = false;
        config.apps!.http!.servers!.srv0.routes!.push({ '@id': 'concurrent-owner-route', handle: [{ handler: 'static_response', body: 'retained' }] });
      }
      if (req.headers['if-match'] !== etag()) {
        res.statusCode = 412; res.end('revision mismatch'); return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { config = JSON.parse(body); res.end(); });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previous = process.env.CADDY_ADMIN_URL;
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${address.port}`;
  try {
    await run({ config: () => structuredClone(config), raceNextWrite: () => { race = true; } });
  } finally {
    if (previous === undefined) delete process.env.CADDY_ADMIN_URL;
    else process.env.CADDY_ADMIN_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('real conditional Caddy writes reject a change arriving between snapshot check and write', async () => {
  await withAdmin(fixtureConfig(), async (admin) => {
    admin.raceNextWrite();
    const fixture = routeFixture();
    await assert.rejects(reconcileManagedRoutes('example.test', {
      ready: fixture.dependencies.ready, resolve: fixture.dependencies.resolve, verify: fixture.dependencies.verify,
    }), /changed concurrently/);
    assert.ok(admin.config().apps!.http!.servers!.srv0.routes!.some((route) => route['@id'] === 'concurrent-owner-route'));
    assert.ok(!admin.config().apps!.http!.servers!.srv0.routes!.some((route) => route['@id'] === 'control-settings-route'));
  });
});

test('ordinary application configuration writers cannot overwrite a newer owner change', async () => {
  await withAdmin(fixtureConfig(), async (admin) => {
    const first = await getConfig();
    const stale = await getConfig();
    first.apps!.http!.servers!.srv0.routes!.push({ '@id': 'first-app-route', handle: [{ handler: 'static_response' }] });
    await setConfig(first);
    await assert.rejects(setConfig(stale), /Caddy API error: 412/);
    assert.ok(admin.config().apps!.http!.servers!.srv0.routes!.some((route) => route['@id'] === 'first-app-route'));
  });
});

test('real rollback preserves the immutable original admin security settings exactly', async () => {
  const original = fixtureConfig();
  original.admin!.enforce_origin = true;
  original.admin!.origins = ['https://admin.example.test'];
  await withAdmin(original, async (admin) => {
    const fixture = routeFixture();
    await assert.rejects(reconcileManagedRoutes('example.test', {
      ready: fixture.dependencies.ready, resolve: fixture.dependencies.resolve,
      verify: async () => { throw new Error('proxy verification failed'); },
    }), /proxy verification failed/);
    assert.deepEqual(admin.config(), original);
    assert.equal(original.admin!.enforce_origin, true);
  });
});

test('real TLS proxy verification trusts the installed Caddy CA, validates hostname, and rejects 502', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-proxy-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-subj', '/CN=example.test', '-addext', 'subjectAltName=DNS:example.test', '-days', '1'], { stdio: 'ignore' });
  const certificate = await readFile(certPath);
  let broken = false;
  let pointerDown = false;
  const probed: string[] = [];
  const server = https.createServer({ key: await readFile(keyPath), cert: certificate }, (req, res) => {
    probed.push(req.url ?? '');
    res.statusCode = broken ? 502 : req.url === '/v1/models' ? (pointerDown ? 502 : 401) : req.url === '/settings/api/auth/mode' ? 200 : 307;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await withIncus((path) => path === '/1.0/instances/youeye-caddy/files?path=%2Fdata%2Fcaddy%2Fpki%2Fauthorities%2Flocal%2Froot.crt'
      ? certificate : { type: 'error', error: 'not found' }, async () => {
      await withAdmin(fixtureConfig(), async () => {
        await verifyManagedProxy('example.test', fixtureConfig(), address.port);
        assert.ok(probed.includes('/v1/models'));
        pointerDown = true;
        await assert.rejects(verifyManagedProxy('example.test', fixtureConfig(), address.port), /\/v1\/models \(HTTP 502\)/);
        probed.length = 0;
        await verifyManagedProxy('example.test', fixtureConfig(), address.port, { pointer: false });
        assert.deepEqual(probed, ['/settings/api/auth/mode', '/settings', '/market']);
        pointerDown = false;
        await assert.rejects(verifyManagedProxy('wrong.example.test', fixtureConfig(), address.port), /proxy probe failed/);
        broken = true;
        await assert.rejects(verifyManagedProxy('example.test', fixtureConfig(), address.port), /HTTP 502/);
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('required setup route failures persist error, prevent completion, and permit a successful retry', async () => {
  const events: string[] = [];
  let persisted = 'pending';
  const persist = async (state: 'done' | 'error') => { persisted = state; };
  const report = (state: 'done' | 'error') => { events.push(state); };
  assert.equal(await recordSetupRouteResult(['Pointer route unavailable'], 'Routes verified', report, persist), true);
  assert.equal(persisted, 'error');
  assert.deepEqual(events, ['error']);
  assert.equal(await recordSetupRouteResult([], 'Routes verified', report, persist), false);
  assert.equal(persisted, 'done');
  assert.deepEqual(events, ['error', 'done']);
});

test('setup never reports success before persistent step status is saved', async () => {
  const events: string[] = [];
  await assert.rejects(recordSetupRouteResult([], 'Routes verified', (state) => events.push(state), async () => {
    throw new Error('state write failed');
  }), /state write failed/);
  assert.deepEqual(events, []);
});
