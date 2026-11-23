import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addForwardAuthToRoute,
  addRoute,
  addScopedAppGrantRoute,
  ensureHeaderStrippingRoute,
  ensureIdentityRoute,
  ensurePingRoute,
  ensureScopedAppGrantDenyRoute,
  ensureSetupHttpServer,
  getRoutes,
  loadExternalCert,
  reconcileManagedRoutes,
  removeExternalCert,
  removeRoute,
  setDefaultRoute,
  setDomain,
} from '../src/lib/caddy/client';
import { controlPanelCaddyfile } from '../src/lib/caddy/caddyfile';
import {
  applySetupHttpServer,
  canonicalJSON,
  hasClientAddressListenerWrappers,
  INTERNAL_CERT_LIFETIME_NS,
  IPV4_HOST_PATTERN,
  MDNS_HOST_PATTERN,
  mainServerName,
  routeServers,
  SETUP_HTTP_SERVER,
  setupHttpServer,
} from '../src/lib/caddy/servers';
import type { CaddyConfig } from '../src/lib/caddy/types';
import { startSetupHttpServerConvergence } from '../src/lib/caddy/setup-http-startup';

const CONTROL_DIAL = '10.45.18.16:3000';

/** Caddy's JSON output: Go encodes maps with sorted keys, so `setup_http` comes before `srv0`. */
const caddyJSON = canonicalJSON;

/** What `caddy adapt` makes of `controlPanelCaddyfile` (Caddy 2.11): one :443 server, srv0. */
function adaptedCaddyfile(): CaddyConfig {
  return {
    admin: { listen: '10.45.18.13:2019', origins: ['10.45.18.13:2019'] },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443'],
            // YE-134: checked with `caddy adapt` on a box (Caddy 2.11.4).
            listener_wrappers: [{ wrapper: 'proxy_protocol', allow: ['127.0.0.1/32'] }, { wrapper: 'tls' }],
            routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: CONTROL_DIAL }] }] }],
            tls_connection_policies: [{}],
            automatic_https: { disable_redirects: true },
          },
        },
      },
      tls: {
        automation: {
          policies: [{ on_demand: true, issuers: [{ module: 'internal', lifetime: INTERNAL_CERT_LIFETIME_NS }] }],
          on_demand: { permission: { module: 'http', endpoint: 'http://10.45.18.16:3000/api/setup/config' } },
        },
      },
      pki: { certificate_authorities: { local: { intermediate_lifetime: 30 * 24 * 3600 * 1e9 } } },
    } as CaddyConfig['apps'],
  };
}

async function withFixtures(initial: CaddyConfig, run: (current: () => CaddyConfig, writes: () => number) => Promise<void>): Promise<void> {
  let body = caddyJSON(initial);
  let writes = 0;
  const caddy = http.createServer((req, res) => {
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    if (req.method === 'GET' && req.url === '/config/') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('etag', etag);
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/config/') {
      if (req.headers['if-match'] !== etag) {
        res.statusCode = 412;
        res.end();
        return;
      }
      let next = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { next += chunk; });
      req.on('end', () => {
        body = caddyJSON(JSON.parse(next));
        writes++;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const dir = await mkdtemp(join(tmpdir(), 'setup-http-incus-'));
  const socket = join(dir, 'incus.sock');
  const incus = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/1.0/networks/incusbr0') {
      res.end(JSON.stringify({ type: 'sync', metadata: { config: { 'ipv4.address': '10.45.18.1/24' } } }));
      return;
    }
    res.end(JSON.stringify({ type: 'error', error_code: 404, error: 'not found' }));
  });
  await new Promise<void>((resolve) => caddy.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => incus.listen(socket, resolve));
  const address = caddy.address();
  assert.ok(address && typeof address === 'object');
  const previous = { admin: process.env.CADDY_ADMIN_URL, socket: process.env.INCUS_SOCKET, https: process.env.INCUS_HTTPS_URL };
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await run(() => JSON.parse(body) as CaddyConfig, () => writes);
  } finally {
    for (const [key, value] of [['CADDY_ADMIN_URL', previous.admin], ['INCUS_SOCKET', previous.socket], ['INCUS_HTTPS_URL', previous.https]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => caddy.close(() => resolve()));
    await new Promise<void>((resolve) => incus.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

function assertLayout(config: CaddyConfig, step: string): void {
  const servers = config.apps?.http?.servers ?? {};
  assert.deepEqual(Object.keys(servers).sort(), [SETUP_HTTP_SERVER, 'srv0'], `${step}: servers`);
  assert.deepEqual(servers[SETUP_HTTP_SERVER], setupHttpServer(CONTROL_DIAL), `${step}: :80 setup server is canonical`);
  assert.deepEqual(servers.srv0.listen, [':443'], `${step}: main server stays on :443`);
  assert.equal(servers.srv0.automatic_https?.disable_redirects, true, `${step}: Caddy adds no redirects of its own`);
  assert.ok(hasClientAddressListenerWrappers(servers.srv0), `${step}: :443 reads a PROXY header first (YE-134)`);
  assert.ok(hasClientAddressListenerWrappers(servers[SETUP_HTTP_SERVER]), `${step}: :80 reads a PROXY header first`);
  for (const policy of config.apps?.tls?.automation?.policies ?? []) {
    for (const issuer of policy.issuers ?? []) {
      if (issuer.module === 'internal') assert.equal(issuer.lifetime, INTERNAL_CERT_LIFETIME_NS, `${step}: 7-day leaves`);
    }
  }
  assert.ok((config.apps as Record<string, unknown>).pki, `${step}: pki app (30-day intermediate) kept`);
}

test('the Caddyfile uses permission http, 7-day leaves, a 30-day intermediate and no automatic redirects', () => {
  const caddyfile = controlPanelCaddyfile('10.45.18.13:2019', '10.45.18.16');
  assert.match(caddyfile, /^ {4}auto_https disable_redirects$/m);
  assert.match(caddyfile, /pki \{\n\s+ca local \{\n\s+intermediate_lifetime 30d\n\s+\}\n\s+\}/);
  // Caddy's PermissionByHTTP takes the endpoint as its one argument (no block).
  assert.match(caddyfile, /on_demand_tls \{\n\s+permission http http:\/\/10\.45\.18\.16:3000\/api\/setup\/config\n\s+\}/);
  assert.doesNotMatch(caddyfile, /\bask\b/);
  assert.match(caddyfile, /issuer internal \{\n\s+lifetime 7d\n\s+\}/);
  assert.match(caddyfile, /admin 10\.45\.18\.13:2019 \{\n\s+origins 10\.45\.18\.13:2019\n\s+\}/);
  assert.equal(INTERNAL_CERT_LIFETIME_NS, 7 * 24 * 3600 * 1e9);
});

test('the :80 setup server proxies the IP and youeye(-N).local to the Control Panel and redirects everything else', () => {
  const server = setupHttpServer(CONTROL_DIAL);
  assert.deepEqual(server.listen, [':80']);
  const [strip, local, redirect] = server.routes;
  assert.equal(strip.handle[0].handler, 'headers');
  assert.ok(((strip.handle[0] as { request: { delete: string[] } }).request.delete).includes('X-Ui-Bridge-Token'));
  assert.equal(strip.match, undefined, 'strip runs for every request');
  assert.deepEqual(local.match, [
    { header_regexp: { Host: { pattern: MDNS_HOST_PATTERN } } },
    { header_regexp: { Host: { pattern: IPV4_HOST_PATTERN } } },
  ]);
  assert.deepEqual(local.handle, [{ handler: 'reverse_proxy', upstreams: [{ dial: CONTROL_DIAL }] }]);
  assert.equal(local.terminal, true);
  assert.equal(redirect.match, undefined);
  assert.deepEqual(redirect.handle, [{
    handler: 'static_response', status_code: 308,
    headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
  }]);
  const ipHost = new RegExp(IPV4_HOST_PATTERN);
  for (const host of ['192.168.1.50', '192.168.1.50:80', '10.0.0.2:8080']) assert.ok(ipHost.test(host), host);
  for (const host of ['youeye.local', 'sandy-spring.ui.bingo', '192.168.1.50.nip.io', '[fe80::1]']) assert.ok(!ipHost.test(host), host);
  // Go RE2's leading (?i) is JavaScript's `i` flag.
  assert.ok(MDNS_HOST_PATTERN.startsWith('(?i)'));
  const mdnsHost = new RegExp(MDNS_HOST_PATTERN.slice(4), 'i');
  for (const host of ['youeye.local', 'youeye.local:80', 'YouEye-2.local', 'youeye-1234.local:8080']) assert.ok(mdnsHost.test(host), host);
  // Any other .local name may be a platform domain: it is redirected to HTTPS like every named host.
  for (const host of ['foo.local', 'youeye-12345.local', 'myyoueye.local', 'youeye.local.evil.example', 'control.youeye.local', '192.168.1.50']) {
    assert.ok(!mdnsHost.test(host), host);
  }
});

test('writers pick the :443 server by listen address, never by key order', () => {
  const config: CaddyConfig = { apps: { http: { servers: {
    [SETUP_HTTP_SERVER]: setupHttpServer(CONTROL_DIAL),
    srv0: { listen: [':443'], routes: [] },
  } } } };
  assert.equal(Object.keys(JSON.parse(caddyJSON(config)).apps.http.servers)[0], SETUP_HTTP_SERVER);
  assert.equal(mainServerName(JSON.parse(caddyJSON(config))), 'srv0');
  assert.deepEqual(routeServers(config), [config.apps!.http!.servers!.srv0]);
  // A Caddy that fell back to its stock :80 config: the stock server becomes the main one, and loses :80.
  const stock: CaddyConfig = { apps: { http: { servers: { srv0: { listen: [':80'], routes: [] } } } } };
  assert.equal(mainServerName(stock), 'srv0');
  assert.equal(applySetupHttpServer(stock, CONTROL_DIAL), true);
  assert.deepEqual(stock.apps!.http!.servers!.srv0.listen, []);
  assert.equal(applySetupHttpServer(stock, CONTROL_DIAL), false, 'idempotent');
  assert.equal(mainServerName({}), 'srv0');
});

test('every Caddy writer keeps the :80 setup server and the :443 main server apart', async () => {
  await withFixtures(adaptedCaddyfile(), async (current) => {
    await setDefaultRoute('youeye-control', 3000);
    assertLayout(current(), 'setDefaultRoute');
    await ensurePingRoute('youeye-control', 3000);
    assertLayout(current(), 'ensurePingRoute');
    await ensureHeaderStrippingRoute();
    assertLayout(current(), 'ensureHeaderStrippingRoute');
    assert.equal(current().apps!.http!.servers!.srv0.routes[0]['@id'], 'security-header-strip');
    assert.ok(current().apps!.http!.servers!.srv0.routes.some((route) => route['@id'] === 'api-ping-route'));

    await setDomain('box.example.test');
    assertLayout(current(), 'setDomain');
    await reconcileManagedRoutes('box.example.test', {
      ready: async () => {}, verify: async () => {}, pointerDeployed: async () => false,
    });
    assertLayout(current(), 'reconcileManagedRoutes');
    await ensureIdentityRoute('id.box.example.test');
    assertLayout(current(), 'ensureIdentityRoute');
    const { route } = await addRoute({ hostname: 'notes.box.example.test', path: '/*', upstream: '10.45.18.40', port: 3000 });
    assertLayout(current(), 'addRoute');
    await addForwardAuthToRoute('notes.box.example.test', { upstreamDial: CONTROL_DIAL, uri: '/forward-auth/caddy', copyHeaders: ['X-Youeye-User'] });
    assertLayout(current(), 'addForwardAuthToRoute');
    await addScopedAppGrantRoute({ id: 'app-grant-notes', hostname: 'notes.box.example.test', upstreamDial: '10.45.18.40:3000', paths: ['/api/*'], appToken: 'token' });
    await ensureScopedAppGrantDenyRoute();
    assertLayout(current(), 'scoped app grants');
    await loadExternalCert('certificate', 'key', ['box.example.test', '*.box.example.test']);
    assertLayout(current(), 'loadExternalCert');
    assert.equal(current().apps!.http!.servers!.srv0.tls_connection_policies![0].certificate_selection?.any_tag?.[0], 'external');
    await removeExternalCert();
    assertLayout(current(), 'removeExternalCert');

    assert.ok((await getRoutes()).every((proxy) => !proxy.id.startsWith('setup-http')), 'setup routes are not app routes');
    await removeRoute(route.id);
    assertLayout(current(), 'removeRoute');

    // A full rebuild from the Caddyfile (Caddy redeployed) drops :80 until the next writer puts it back.
    const before = current();
    await withFixtures(adaptedCaddyfile(), async (rebuilt, writes) => {
      await ensureSetupHttpServer();
      assertLayout(rebuilt(), 'ensureSetupHttpServer');
      assert.equal(writes(), 1);
      await ensureSetupHttpServer();
      assert.equal(writes(), 1, 'no write when already converged');
    });
    assert.deepEqual(before.apps!.http!.servers![SETUP_HTTP_SERVER], setupHttpServer(CONTROL_DIAL));
  });
});

/** A box set up before the setup server existed: Caddy's autosave has srv0 on :443 and its own redirects. */
function preSetupServerConfig(disableRedirects: boolean): CaddyConfig {
  const config = adaptedCaddyfile();
  const srv0 = config.apps!.http!.servers!.srv0;
  srv0.routes = [{ '@id': 'default-catchall', handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: CONTROL_DIAL }] }] }];
  if (disableRedirects) srv0.automatic_https = { disable_redirects: true };
  else delete srv0.automatic_https;
  return config;
}

test('without the setup server, route writers keep Caddy\'s own HTTP->HTTPS redirects', async () => {
  for (const disableRedirects of [false, true]) {
    await withFixtures(preSetupServerConfig(disableRedirects), async (current) => {
      await addRoute({ hostname: 'notes.box.example.test', path: '/*', upstream: '10.45.18.40', port: 3000 });
      await setDomain('box.example.test');
      await ensureIdentityRoute('id.box.example.test');
      const servers = current().apps!.http!.servers!;
      assert.deepEqual(Object.keys(servers), ['srv0'], 'no :80 server yet');
      assert.notEqual(servers.srv0.automatic_https?.disable_redirects, true, `redirects stay on (was ${disableRedirects})`);
      assert.deepEqual(servers.srv0.listen, [':443']);
      assert.ok(hasClientAddressListenerWrappers(servers.srv0), 'every write puts the wrappers on :443');

      // The Control Panel start (or reconcile) adds the setup server; only then are Caddy's redirects off.
      await ensureSetupHttpServer();
      assertLayout(current(), 'ensureSetupHttpServer on an updated box');
      // And later writers keep them off.
      await addRoute({ hostname: 'wiki.box.example.test', path: '/*', upstream: '10.45.18.41', port: 3000 });
      assertLayout(current(), 'addRoute after the setup server');
    });
  }
});

test('the setup server is ensured at Control Panel start, retrying while Caddy is not up', async () => {
  let calls = 0;
  const scheduled: number[] = [];
  const ensured = await startSetupHttpServerConvergence({
    ensure: async () => { calls++; if (calls < 3) throw new Error('connect ECONNREFUSED'); },
    retryMs: 5_000,
    schedule: (run, ms) => { scheduled.push(ms); setImmediate(run); },
  });
  assert.equal(ensured, true);
  assert.equal(calls, 3);
  assert.deepEqual(scheduled, [5_000, 5_000]);

  const warn = console.warn;
  console.warn = () => {};
  try {
    const gaveUp = await startSetupHttpServerConvergence({
      ensure: async () => { throw new Error('Caddy is down'); }, attempts: 2, schedule: (run) => setImmediate(run),
    });
    assert.equal(gaveUp, false, 'never throws');
  } finally {
    console.warn = warn;
  }
});

test('the Control Panel start hook runs the setup server convergence', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/instrumentation.ts', import.meta.url), 'utf8');
  assert.match(source, /startSetupHttpServerConvergence\(\)/);
});
