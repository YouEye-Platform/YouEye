/**
 * Real client addresses behind Caddy (YE-134): the PROXY protocol listener wrappers on every :80 and :443 server,
 * and `youeye-caddy`'s proxy devices only ever sending headers to servers that read them.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addRoute, ensureClientAddressListenerWrappers, generateInitialConfig, reconcileManagedRoutes, setConfig } from '../src/lib/caddy/client';
import { controlPanelCaddyfile } from '../src/lib/caddy/caddyfile';
import {
  caddyProxyDevicesForPort,
  ensureClientAddresses,
  planClientAddressDevices,
  PROXY_DEVICES_SEND_CLIENT_ADDRESS,
  reconcileClientAddressDevices,
  type InstanceDevices,
} from '../src/lib/caddy/client-address';
import {
  applyClientAddressListenerWrappers,
  canonicalJSON,
  clientAddressListenerWrappers,
  hasClientAddressListenerWrappers,
  mainServer,
  newMainServer,
  portReadsClientAddresses,
  PROXY_DEVICE_SOURCE,
  SETUP_HTTP_SERVER,
  setupHttpServer,
} from '../src/lib/caddy/servers';
import type { CaddyConfig } from '../src/lib/caddy/types';

const CONTROL_DIAL = '10.45.18.16:3000';
const WRAPPERS = [{ wrapper: 'proxy_protocol', allow: ['127.0.0.1/32'] }, { wrapper: 'tls' }];

/** A box's autosaved config from before YE-134: :443 and the :80 setup server, no listener wrappers. */
function configWithoutWrappers(): CaddyConfig {
  const setup = setupHttpServer(CONTROL_DIAL);
  delete setup.listener_wrappers;
  return {
    admin: { listen: '10.45.18.13:2019', enforce_origin: false },
    apps: { http: { servers: {
      [SETUP_HTTP_SERVER]: setup,
      srv0: {
        listen: [':443'],
        routes: [{ '@id': 'default-catchall', handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: CONTROL_DIAL }] }] }],
        tls_connection_policies: [{}],
        automatic_https: { disable_redirects: true },
      },
    } } },
  };
}

function withWrappers(): CaddyConfig {
  const config = configWithoutWrappers();
  applyClientAddressListenerWrappers(config);
  return config;
}

/** youeye-caddy's devices as the deployer makes them (`oci-deployer.ts`). */
function caddyDevices(flags: { p80?: boolean; p443?: boolean } = {}): InstanceDevices {
  return {
    eth0: { type: 'nic', network: 'incusbr0', name: 'eth0' },
    proxy0: { type: 'proxy', listen: 'tcp:0.0.0.0:80', connect: 'tcp:127.0.0.1:80', ...(flags.p80 ? { proxy_protocol: 'true' } : {}) },
    proxy1: { type: 'proxy', listen: 'tcp:0.0.0.0:443', connect: 'tcp:127.0.0.1:443', ...(flags.p443 ? { proxy_protocol: 'true' } : {}) },
    volume0: { type: 'disk', source: '/var/lib/youeye/caddy/data', path: '/data', shift: 'true' },
  };
}

async function withCaddy(initial: CaddyConfig, run: (current: () => CaddyConfig, writes: () => number) => Promise<void>): Promise<void> {
  let body = canonicalJSON(initial);
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
      if (req.headers['if-match'] !== etag) { res.statusCode = 412; res.end(); return; }
      let next = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { next += chunk; });
      req.on('end', () => { body = canonicalJSON(JSON.parse(next)); writes++; res.end(); });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const dir = await mkdtemp(join(tmpdir(), 'client-address-incus-'));
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

test('the wrappers: PROXY header from 127.0.0.1 only, then TLS', () => {
  assert.equal(PROXY_DEVICE_SOURCE, '127.0.0.1/32');
  assert.deepEqual(clientAddressListenerWrappers(), WRAPPERS);
  assert.deepEqual(setupHttpServer(CONTROL_DIAL).listener_wrappers, WRAPPERS, ':80 setup server');
  assert.deepEqual(newMainServer().listener_wrappers, WRAPPERS, 'new :443 server');
  assert.deepEqual(mainServer({}).listener_wrappers, WRAPPERS, 'main server created on an empty config');
  assert.deepEqual(generateInitialConfig(['box.example.test']).apps!.http!.servers!.srv0.listener_wrappers, WRAPPERS);
  assert.equal(hasClientAddressListenerWrappers({ listen: [':443'], routes: [] }), false);
  assert.equal(hasClientAddressListenerWrappers({ listen: [':443'], routes: [], listener_wrappers: [...WRAPPERS].reverse() }), false,
    'TLS before the PROXY header cannot read it');
  assert.equal(hasClientAddressListenerWrappers({ listen: [':443'], routes: [], listener_wrappers: [{ wrapper: 'proxy_protocol' }, { wrapper: 'tls' }] }), false,
    'no source allowed: Caddy would ignore every header');
  assert.equal(hasClientAddressListenerWrappers({ listen: [':443'], routes: [], listener_wrappers: [WRAPPERS[0]] }), false,
    'without tls Caddy runs TLS first');
  assert.equal(hasClientAddressListenerWrappers({ listen: [':443'], routes: [], listener_wrappers: [WRAPPERS[0], { wrapper: 'http_redirect' }, { wrapper: 'tls' }] }), true);
});

test('the deploy Caddyfile puts the same wrappers on every server', () => {
  const caddyfile = controlPanelCaddyfile('10.45.18.13:2019', '10.45.18.16');
  assert.match(caddyfile, /\n {4}servers \{\n {8}listener_wrappers \{\n {12}proxy_protocol \{\n {16}allow 127\.0\.0\.1\/32\n {12}\}\n {12}tls\n {8}\}\n {4}\}\n/);
  // A global option: before the first site block.
  assert.ok(caddyfile.indexOf('servers {') < caddyfile.indexOf(':443 {'));
});

test('applyClientAddressListenerWrappers covers :80 and :443 only, keeps other wrappers where they were, and is idempotent', () => {
  const config = configWithoutWrappers();
  config.apps!.http!.servers!.other = { listen: [':8443'], routes: [] };
  config.apps!.http!.servers!.srv0.listener_wrappers = [{ wrapper: 'http_redirect' }, { wrapper: 'tls' }, { wrapper: 'example' }];
  assert.equal(portReadsClientAddresses(config, 443), false);
  assert.equal(applyClientAddressListenerWrappers(config), true);
  const servers = config.apps!.http!.servers!;
  assert.deepEqual(servers.srv0.listener_wrappers,
    [WRAPPERS[0], { wrapper: 'http_redirect' }, { wrapper: 'tls' }, { wrapper: 'example' }], 'http_redirect stays before tls');
  const noTls = configWithoutWrappers();
  noTls.apps!.http!.servers!.srv0.listener_wrappers = [{ wrapper: 'example' }];
  applyClientAddressListenerWrappers(noTls);
  assert.deepEqual(noTls.apps!.http!.servers!.srv0.listener_wrappers, [...WRAPPERS, { wrapper: 'example' }],
    'without tls, Caddy did TLS first: tls goes right after proxy_protocol');
  assert.deepEqual(servers[SETUP_HTTP_SERVER].listener_wrappers, WRAPPERS);
  assert.equal(servers.other.listener_wrappers, undefined, 'a server the proxy devices never reach is left alone');
  assert.equal(portReadsClientAddresses(config, 443), true);
  assert.equal(portReadsClientAddresses(config, 80), true);
  assert.equal(applyClientAddressListenerWrappers(config), false, 'idempotent');
});

test('every write adds the wrappers, a full config from the API included; the start check converges an old autosave once', async () => {
  await withCaddy(configWithoutWrappers(), async (current, writes) => {
    assert.equal(await ensureClientAddressListenerWrappers(), true);
    assert.equal(writes(), 1);
    assert.ok(portReadsClientAddresses(current(), 443) && portReadsClientAddresses(current(), 80));
    assert.equal(await ensureClientAddressListenerWrappers(), false, 'no write once converged');
    assert.equal(writes(), 1);
  });
  await withCaddy(withWrappers(), async (current) => {
    // A caller (the /api/caddy/config route, a TLS rollback) hands over a full config without wrappers.
    const posted = configWithoutWrappers();
    await setConfig(posted);
    assert.deepEqual(current().apps!.http!.servers!.srv0.listener_wrappers, WRAPPERS);
    assert.equal(canonicalJSON(posted.apps), canonicalJSON(current().apps), 'the caller\'s object matches what Caddy reads back');
    assert.deepEqual(current().apps!.http!.servers![SETUP_HTTP_SERVER].listener_wrappers, WRAPPERS);
    await addRoute({ hostname: 'notes.box.example.test', path: '/*', upstream: '10.45.18.40', port: 3000 });
    assert.ok(portReadsClientAddresses(current(), 443) && portReadsClientAddresses(current(), 80));
  });
});

test('the managed-route repair (setConfigExact) writes the wrappers too', async () => {
  await withCaddy(configWithoutWrappers(), async (current, writes) => {
    await reconcileManagedRoutes('box.example.test', {
      ready: async () => {}, verify: async () => {}, pointerDeployed: async () => false,
      resolve: async (_name, port) => `10.45.18.16:${port}`,
    });
    assert.equal(writes(), 1);
    assert.ok(portReadsClientAddresses(current(), 443) && portReadsClientAddresses(current(), 80));
  });
});

test('devices are found by what they connect to, not by name', () => {
  const devices = caddyDevices();
  assert.deepEqual(caddyProxyDevicesForPort(devices, 443), ['proxy1']);
  assert.deepEqual(caddyProxyDevicesForPort(devices, 80), ['proxy0']);
  assert.deepEqual(caddyProxyDevicesForPort({ web: devices.proxy1, extra: devices.proxy1 }, 443), ['extra', 'web']);
  assert.deepEqual(caddyProxyDevicesForPort(devices, 53), []);
});

test('every device to a port is healed, and Incus booleans other than "true" count as set', () => {
  const lost = withWrappers();
  delete lost.apps!.http!.servers!.srv0.listener_wrappers;
  const devices = caddyDevices();
  devices.proxy1.proxy_protocol = 'yes';
  devices.extra = { ...caddyDevices().proxy1, listen: 'tcp:0.0.0.0:8443', proxy_protocol: '1' };
  assert.deepEqual(planClientAddressDevices(devices, lost, false).changes, [
    { device: 'extra', port: 443, proxyProtocol: false },
    { device: 'proxy1', port: 443, proxyProtocol: false },
  ]);
});

test('self-heal: a device flag without the wrapper on its port is removed; with the wrapper it stays', () => {
  // This release sends headers (0.6.16, its minimum release, brought the wrappers); 0.6.16 never set the flag.
  assert.equal(PROXY_DEVICES_SEND_CLIENT_ADDRESS, true);
  assert.deepEqual(planClientAddressDevices(caddyDevices(), withWrappers(), false).changes, []);

  // Flags from a later release, wrappers in place (a Control Panel rolled back to this release): kept.
  assert.deepEqual(planClientAddressDevices(caddyDevices({ p80: true, p443: true }), withWrappers(), false).changes, []);

  // :443's server lost its wrappers (an older writer, a restored autosave): only :443's flag goes.
  const lost = withWrappers();
  delete lost.apps!.http!.servers!.srv0.listener_wrappers;
  const healed = planClientAddressDevices(caddyDevices({ p80: true, p443: true }), lost, false);
  assert.deepEqual(healed.changes, [{ device: 'proxy1', port: 443, proxyProtocol: false }]);
  assert.equal(healed.devices.proxy1.proxy_protocol, undefined);
  assert.equal(healed.devices.proxy0.proxy_protocol, 'true');
  assert.deepEqual(healed.devices.eth0, caddyDevices().eth0, 'other devices unchanged');
  assert.deepEqual(healed.devices.proxy1, caddyDevices().proxy1, 'the device is otherwise unchanged');

  // No server of ours on :80 (Caddy's own redirect server would take it, without wrappers): :80's flag goes too.
  const noSetup = withWrappers();
  delete noSetup.apps!.http!.servers![SETUP_HTTP_SERVER];
  assert.deepEqual(planClientAddressDevices(caddyDevices({ p80: true, p443: true }), noSetup, false).changes,
    [{ device: 'proxy0', port: 80, proxyProtocol: false }]);

  // Even when this release sends headers, a port without the wrappers never gets the flag.
  assert.deepEqual(planClientAddressDevices(caddyDevices(), noSetup, true).changes,
    [{ device: 'proxy1', port: 443, proxyProtocol: true }]);
  assert.deepEqual(planClientAddressDevices(caddyDevices(), withWrappers(), true).changes, [
    { device: 'proxy0', port: 80, proxyProtocol: true },
    { device: 'proxy1', port: 443, proxyProtocol: true },
  ]);
});

test('reconcileClientAddressDevices writes the whole device map, reads it back, and does nothing without Caddy', async () => {
  let devices: InstanceDevices | null = caddyDevices({ p443: true });
  const written: InstanceDevices[] = [];
  const lost = withWrappers();
  delete lost.apps!.http!.servers!.srv0.listener_wrappers;
  const logs: string[] = [];
  const changes = await reconcileClientAddressDevices({
    getConfig: async () => lost,
    getDevices: async () => devices,
    setDevices: async (next) => { written.push(next); devices = next; },
    send: false,
    log: (message) => logs.push(message),
  });
  assert.deepEqual(changes, [{ device: 'proxy1', port: 443, proxyProtocol: false }]);
  assert.equal(written.length, 1);
  assert.deepEqual(Object.keys(written[0]).sort(), ['eth0', 'proxy0', 'proxy1', 'volume0']);
  assert.match(logs[0], /proxy1 \(:443\) stopped sending PROXY headers/);

  assert.deepEqual(await reconcileClientAddressDevices({
    getConfig: async () => lost, getDevices: async () => devices, setDevices: async () => { throw new Error('no write'); },
    send: false, log: () => {},
  }), [], 'converged: no write');

  await assert.rejects(reconcileClientAddressDevices({
    getConfig: async () => lost,
    getDevices: async () => caddyDevices({ p443: true }),
    setDevices: async () => {},
    send: false,
    log: () => {},
  }), /did not read back/);

  assert.deepEqual(await reconcileClientAddressDevices({
    getConfig: async () => { throw new Error('not asked'); }, getDevices: async () => null,
    setDevices: async () => { throw new Error('no write'); }, send: false, log: () => {},
  }), [], 'no youeye-caddy (first boot before the deploy)');

  // Caddy's config cannot be read: no server is proven to read headers, so every flag goes, and the error is thrown.
  let failSafe: InstanceDevices = caddyDevices({ p80: true, p443: true });
  await assert.rejects(reconcileClientAddressDevices({
    getConfig: async () => { throw new Error('connect ECONNREFUSED'); },
    getDevices: async () => failSafe,
    setDevices: async (next) => { failSafe = next; },
    send: true,
    log: () => {},
  }), /ECONNREFUSED/);
  assert.equal(failSafe.proxy0.proxy_protocol, undefined);
  assert.equal(failSafe.proxy1.proxy_protocol, undefined);
});

test('the devices are reconciled even when the wrappers could not be written, and the failure is still reported', async () => {
  const calls: string[] = [];
  await assert.rejects(ensureClientAddresses(
    async () => { calls.push('wrappers'); throw new Error('Caddy API error: 400'); },
    async () => { calls.push('devices'); },
  ), /Caddy API error: 400/);
  assert.deepEqual(calls, ['wrappers', 'devices']);
});

test('every Control Panel start, the infrastructure reconcile and the health monitor run the check', async () => {
  const { runStartupReconciliation } = await import('../src/lib/incus/startup-reconciliation');
  assert.equal(typeof runStartupReconciliation, 'function');
  const root = process.env.CONTROL_PANEL_ROOT ?? process.cwd();
  const startup = readFileSync(join(root, 'src/lib/incus/startup-reconciliation.ts'), 'utf8');
  assert.match(startup, /await \(await import\('@\/lib\/caddy\/client-address'\)\)\.ensureClientAddresses\(\)\n\s+\.catch/);
  assert.ok(startup.indexOf('ensureClientAddresses()') < startup.indexOf('reconcileManagedRoutes(raw.domain)')
    && startup.indexOf('reconcileManagedRoutes(raw.domain)') < startup.indexOf('if (clientAddressFailure) throw'),
  'the managed routes are repaired before a client address failure is thrown');
  const monitor = readFileSync(join(root, 'src/lib/health/monitor.ts'), 'utf8');
  assert.match(monitor, /checkClientAddressDevices\(\);/);
  const deployer = readFileSync(join(root, 'src/lib/infrastructure/deployer.ts'), 'utf8');
  assert.match(deployer, /await ensureSetupHttpServer\('youeye-control', 3000\);\n(\s+\/\/[^\n]*\n)+\s+await ensureClientAddresses\(\)\.catch\(warnClientAddresses\);/);
  // Fresh deploy and redeploy: after Caddy runs the Control Panel's config, never at instance creation.
  assert.equal(deployer.match(/await ensureHeaderStrippingRoute\(\);\n(\s+\/\/[^\n]*\n)*\s+await ensureClientAddresses\(\)\.catch\(warnClientAddresses\);/g)?.length, 2);
  const oci = readFileSync(join(root, 'src/lib/infrastructure/oci-deployer.ts'), 'utf8');
  assert.doesNotMatch(oci, /proxy_protocol/, 'devices are created without the flag');
  const minimum = readFileSync(join(root, '../.youeye/minimum-release'), 'utf8').trim();
  assert.equal(minimum, '0.6.16', 'no box reaches this release without the wrappers');
});
