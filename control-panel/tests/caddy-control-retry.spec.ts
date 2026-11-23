/**
 * YE-138: a Control Panel restart (the one setup asks for, a URL change, a restore, an update) closed its port for a
 * moment and Caddy answered 502. Every route to the Control Panel's container now retries a refused upstream
 * (`applyControlPanelRetry` in `servers.ts`), on every write (`setConfig`) and at every start (managed-route
 * reconcile, `caddy-managed-reconciliation.spec.ts`).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { controlPanelDials, setConfig } from '../src/lib/caddy/client';
import {
  applyControlPanelRetry,
  canonicalJSON,
  CONTROL_PANEL_TRY_DURATION,
  CONTROL_PANEL_TRY_INTERVAL,
  setupHttpServer,
} from '../src/lib/caddy/servers';
import type { CaddyConfig } from '../src/lib/caddy/types';

const CONTROL_IP = '10.45.18.16';
const RETRY = { try_duration: '10s', try_interval: '250ms' };
const proxy = (...dials: string[]) => ({ handler: 'reverse_proxy', upstreams: dials.map((dial) => ({ dial })) });

/** A box's config before YE-138: Control Panel routes by address and by name, YouEye ID, apps, Pointer. */
function config(): CaddyConfig {
  return {
    admin: { listen: '10.45.18.13:2019', enforce_origin: false },
    apps: { http: { servers: { srv0: {
      listen: [':443'],
      routes: [
        { '@id': 'control', match: [{ host: ['control.box.test'] }], handle: [proxy(`${CONTROL_IP}:3000`)] },
        { '@id': 'ping', match: [{ path: ['/api/ping'] }], handle: [proxy('youeye-control.youeye:3000')] },
        { '@id': 'id', match: [{ host: ['id.box.test'] }], handle: [proxy(`${CONTROL_IP}:3001`)] },
        {
          '@id': 'app-with-sign-in', match: [{ host: ['notes.box.test'] }],
          handle: [{ handler: 'subroute', routes: [{ handle: [
            { ...proxy(`${CONTROL_IP}:3001`), rewrite: { method: 'GET', uri: '/forward-auth/caddy' } },
            proxy('10.45.18.40:3000'),
          ] }] }],
        },
        { '@id': 'ui', match: [{ host: ['box.test'] }], handle: [proxy('10.45.18.15:3000')] },
        { '@id': 'pointer', match: [{ path: ['/v1/*'] }], handle: [proxy('10.45.18.17:4002')] },
        { '@id': 'mixed', match: [{ host: ['mixed.box.test'] }], handle: [proxy(`${CONTROL_IP}:3000`, '10.45.18.40:3000')] },
        { '@id': 'other-port', match: [{ host: ['dev.box.test'] }], handle: [proxy(`${CONTROL_IP}:8080`)] },
      ],
    } } } },
  } as unknown as CaddyConfig;
}

function route(value: CaddyConfig, id: string): Record<string, unknown> {
  return value.apps!.http!.servers!.srv0.routes!.find((item) => item['@id'] === id) as unknown as Record<string, unknown>;
}
const handler = (value: CaddyConfig, id: string, index = 0) => (route(value, id).handle as Array<Record<string, unknown>>)[index];
const forwardAuth = (value: CaddyConfig) =>
  ((handler(value, 'app-with-sign-in').routes as Array<{ handle: Array<Record<string, unknown>> }>)[0].handle);

test('the retry rides out a restart of about 0.3 s many times over and is short enough to fail a dead upstream', () => {
  assert.equal(CONTROL_PANEL_TRY_DURATION, RETRY.try_duration);
  assert.equal(CONTROL_PANEL_TRY_INTERVAL, RETRY.try_interval);
});

test('the dials of the Control Panel container: :3000 and :3001, by address and by every name', () => {
  assert.deepEqual([...controlPanelDials(CONTROL_IP)].sort(), [
    '10.45.18.16:3000', '10.45.18.16:3001',
    'youeye-control.incus:3000', 'youeye-control.incus:3001',
    'youeye-control.youeye:3000', 'youeye-control.youeye:3001',
    'youeye-control:3000', 'youeye-control:3001',
  ]);
  assert.equal([...controlPanelDials(null)].some((dial) => dial.startsWith('10.')), false, 'no address: names only');
});

test('every handler to the Control Panel container gets the retry; apps, UI, Pointer and mixed upstreams do not', () => {
  const value = config();
  assert.equal(applyControlPanelRetry(value, controlPanelDials(CONTROL_IP)), true);
  for (const id of ['control', 'ping', 'id']) assert.deepEqual(handler(value, id).load_balancing, RETRY, id);
  assert.deepEqual(forwardAuth(value)[0].load_balancing, RETRY, 'forward auth to YouEye ID, inside a subroute');
  assert.equal(forwardAuth(value)[1].load_balancing, undefined, 'the app itself');
  for (const id of ['ui', 'pointer', 'mixed', 'other-port']) assert.equal(handler(value, id).load_balancing, undefined, id);
  assert.equal(applyControlPanelRetry(value, controlPanelDials(CONTROL_IP)), false, 'a second pass changes nothing');
});

test('other load-balancing settings stay; a different retry is corrected', () => {
  const value = config();
  handler(value, 'control').load_balancing = { selection_policy: { policy: 'first' }, try_duration: '1s' };
  applyControlPanelRetry(value, controlPanelDials(CONTROL_IP));
  assert.deepEqual(handler(value, 'control').load_balancing, { selection_policy: { policy: 'first' }, ...RETRY });
});

test('the :80 setup server is built with the retry, so converging it is still a no-op', () => {
  const server = setupHttpServer(`${CONTROL_IP}:3000`);
  assert.equal(applyControlPanelRetry({ server }, controlPanelDials(CONTROL_IP)), false);
});

/** A fake Caddy admin API (ETag/If-Match like the real one) and, when `incusUp`, a fake Incus for the subnet. */
async function withCaddy(initial: CaddyConfig, incusUp: boolean, run: (current: () => CaddyConfig) => Promise<void>): Promise<void> {
  let body = canonicalJSON(initial);
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
      req.on('end', () => { body = canonicalJSON(JSON.parse(next)); res.end(); });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const dir = await mkdtemp(join(tmpdir(), 'control-retry-incus-'));
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
  if (incusUp) await new Promise<void>((resolve) => incus.listen(socket, resolve));
  const address = caddy.address();
  assert.ok(address && typeof address === 'object');
  const previous = { admin: process.env.CADDY_ADMIN_URL, socket: process.env.INCUS_SOCKET, https: process.env.INCUS_HTTPS_URL };
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await run(() => JSON.parse(body) as CaddyConfig);
  } finally {
    for (const [key, value] of [['CADDY_ADMIN_URL', previous.admin], ['INCUS_SOCKET', previous.socket], ['INCUS_HTTPS_URL', previous.https]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => caddy.close(() => resolve()));
    if (incusUp) await new Promise<void>((resolve) => incus.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

// Incus unreachable first: the subnet, once read, is cached for the process.
test('a write while Incus cannot be reached still gives the routes that name the Control Panel the retry', async () => {
  await withCaddy(config(), false, async (current) => {
    const value = config();
    await setConfig(value);
    assert.deepEqual(handler(current(), 'ping').load_balancing, RETRY);
    assert.equal(handler(current(), 'control').load_balancing, undefined, 'its address is unknown: left as it was');
  });
});

test('every write (any writer, a full config included) gives the Control Panel routes the retry', async () => {
  await withCaddy(config(), true, async (current) => {
    const value = config();
    await setConfig(value);
    for (const id of ['control', 'ping', 'id']) assert.deepEqual(handler(current(), id).load_balancing, RETRY, id);
    assert.deepEqual(forwardAuth(current())[0].load_balancing, RETRY);
    for (const id of ['ui', 'pointer', 'mixed']) assert.equal(handler(current(), id).load_balancing, undefined, id);
    assert.deepEqual(handler(value, 'control').load_balancing, RETRY, "on the caller's object too, like the wrappers");
  });
});
