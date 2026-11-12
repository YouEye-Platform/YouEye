import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { loadApp } from '../src/lib/market/app-format/compile';
import type { SetupStep } from '../src/lib/market/app-format/schema';
import {
  cappedFetch, runSetup, SETUP_LIMITS, SetupStepError,
  type SetupHttpRequest, type SetupPurpose, type SetupRunContext, type SetupTransport,
} from '../src/lib/market/setup-runner';
import { runConnectionWiring, type WiringDeps } from '../src/lib/market/wire-runner';
import { setupContainers } from '../src/lib/market/setup-context';
import { connectionInterface } from '../src/lib/incus/connection-nic';
import type { AppManifest, ContainerSpec, InstallMetadata, SetupFile, VariableContext } from '../src/lib/market/types';
import { appFixture } from './fixtures/app-format';
import { checkAppAddress } from '../src/lib/incus/app-network-ipam';

const root = process.env.CONTROL_PANEL_ROOT ?? path.resolve(__dirname, '..');

// ─── Fake transport ───────────────────────────────────────

interface HttpCall { method: string; url: string; host: string; port: number; path: string; headers: Record<string, string>; body?: string }
type Responder = (call: HttpCall) => { status?: number; body?: unknown } | undefined;

interface Fake extends SetupTransport {
  http: HttpCall[];
  execs: { container: string; argv: string[]; timeoutMs: number }[];
  files: { container: string; path: string; data: string; mode: string }[];
  restarts: string[];
  sleeps: number[];
}

const ADDRESSES: Record<string, string> = {
  'app-demo': '10.10.0.2',
  'app-demo-main': '10.10.0.2',
  'app-demo-worker': '10.10.0.3',
  'app-peer': '10.20.0.2',
};

function fakeTransport(respond: Responder = () => undefined, options: {
  exitCode?: (argv: string[]) => number;
} = {}): Fake {
  const fake: Fake = {
    http: [], execs: [], files: [], restarts: [], sleeps: [],
    async address(container, _network, iface) {
      // A connection NIC: the consumer's address on the peer's network.
      if (iface) return `${ADDRESSES[container] ?? '10.99.0.2'}|${iface}` === `10.10.0.2|${connectionInterface('peer')}` ? '10.20.0.7' : '10.99.0.9';
      const ip = ADDRESSES[container] ?? '10.99.0.2';
      return ip;
    },
    async fetch(url: string, request: SetupHttpRequest) {
      const parsed = new URL(url);
      const call: HttpCall = {
        method: request.method, url, host: parsed.hostname, port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`, headers: { ...request.headers }, body: request.body,
      };
      fake.http.push(call);
      const reply = respond(call) ?? {};
      const body = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, body };
    },
    async exec(container, argv, timeoutMs) {
      fake.execs.push({ container, argv, timeoutMs });
      return { exitCode: options.exitCode?.(argv) ?? 0, stdout: '', stderr: 'boom' };
    },
    async writeFile(container, filePath, data, mode) {
      fake.files.push({ container, path: filePath, data: data.toString('utf8'), mode });
    },
    async restart(container) { fake.restarts.push(container); },
    async sleep(ms) { fake.sleeps.push(ms); },
  };
  return fake;
}

function container(name: string, port?: number): ContainerSpec {
  return { name, type: 'oci', primary: name === 'main', image: 'x', port, environment: {}, volumes: [], network: 'isolated' };
}

/** A hand-built manifest, so tests can reach the runner with files the parser would refuse. */
function manifestWith(steps: unknown[], options: { for?: string; remove?: unknown[]; containers?: ContainerSpec[] } = {}): Pick<AppManifest, 'setups' | 'containers'> {
  const file: SetupFile = {
    name: 'setup/test.yaml',
    for: options.for ?? 'sso',
    steps: steps as SetupStep[],
    remove: options.remove as SetupStep[] | undefined,
  };
  return { setups: [file], containers: options.containers ?? [container('main', 8080), container('worker')] };
}

const VARIABLES: Partial<VariableContext> = {
  app: { id: 'demo', name: 'Demo', subdomain: 'demo', fqdn: 'demo.box.test', url: 'https://demo.box.test', internal_url: 'http://app-demo.youeye:8080' },
  secret: { admin_password: 'pw-secret' },
  sso: {
    slug: 'youeye-app-demo', issuer: 'http://10.10.0.1:3002/application/o/youeye-app-demo/', discovery_url: 'http://10.10.0.1:3002/d',
    authorize_url: 'https://id.box.test/application/o/authorize', client_id: 'youeye-app-demo', client_secret: 'cs',
    callback_url: 'https://demo.box.test/cb', logout_url: 'https://id.box.test/logout', admin_group: 'admin',
  },
  identity: { name: 'YouEye ID', external_url: 'https://id.box.test', internal_url: 'http://10.10.0.1:3002' },
};

function context(transport: SetupTransport, changes: Partial<SetupRunContext> = {}): SetupRunContext {
  return {
    appId: 'demo',
    containers: { main: 'app-demo-main', worker: 'app-demo-worker' },
    variables: VARIABLES,
    transport,
    ...changes,
  };
}

async function run(steps: unknown[], respond?: Responder, options: { for?: string; remove?: unknown[]; purpose?: SetupPurpose; context?: Partial<SetupRunContext> } = {}) {
  const fake = fakeTransport(respond);
  const ran = await runSetup(manifestWith(steps, options), options.purpose ?? (options.for as SetupPurpose) ?? 'sso', context(fake, options.context));
  return { fake, ran };
}

async function refused(steps: unknown[], pattern: RegExp, respond?: Responder, options: Parameters<typeof run>[2] = {}) {
  const fake = fakeTransport(respond);
  await assert.rejects(
    runSetup(manifestWith(steps, options), options.purpose ?? (options.for as SetupPurpose) ?? 'sso', context(fake, options.context)),
    (error: unknown) => {
      assert.ok(error instanceof SetupStepError, `expected SetupStepError, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
  return fake;
}

// ─── Step types ───────────────────────────────────────────

test('no setup file, or no remove steps, is a no-op', async () => {
  const fake = fakeTransport();
  assert.equal(await runSetup(appFixture(), 'sso', context(fake)), false);
  assert.equal(await runSetup(manifestWith([{ sleep: 1 }]), 'sso', context(fake, { remove: true })), false);
  assert.equal(fake.sleeps.length, 0);
});

test('wait polls the app until a 2xx', async () => {
  let calls = 0;
  const { fake } = await run([{ wait: { http: '/health', timeout: 30 } }], () => ({ status: ++calls < 3 ? 503 : 200 }));
  assert.equal(fake.http.length, 3);
  assert.equal(fake.http[0].url, 'http://10.10.0.2:8080/health');
  assert.equal(fake.sleeps.length, 2);
});

test('wait fails after its timeout', async () => {
  const fake = fakeTransport(() => ({ status: 503 }));
  // The fake sleep returns at once; let the deadline pass for real.
  fake.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 300)));
  await assert.rejects(runSetup(manifestWith([{ wait: { http: '/health', timeout: 1 } }]), 'sso', context(fake)),
    /was not ready in time \(HTTP 503\)/);
});

test('http sends method, headers and an interpolated body; saves from the response', async () => {
  const { fake } = await run([
    { http: { method: 'POST', path: '/login', headers: { 'X-Client': 'YouEye ${app.name}' }, body: { user: 'admin', password: '${secret.admin_password}', remember: true }, save: { token: 'data.tokens[0].value', all: '$' } } },
    { http: { method: 'GET', path: '/me', headers: { Authorization: 'Bearer ${vars.token}' } } },
  ], (call) => call.path === '/login' ? { body: { data: { tokens: [{ value: 'tok-1' }] } } } : { status: 204 });
  const [login, me] = fake.http;
  assert.equal(login.method, 'POST');
  assert.equal(login.headers['X-Client'], 'YouEye Demo');
  assert.deepEqual(JSON.parse(login.body!), { user: 'admin', password: 'pw-secret', remember: true });
  assert.equal(me.headers.Authorization, 'Bearer tok-1');
  assert.equal(me.body, undefined);
});

test('object and array bodies are JSON with Content-Type set automatically; strings are sent as is', async () => {
  const { fake } = await run([
    { http: { method: 'POST', path: '/a', body: { a: 1 } } },
    { http: { method: 'POST', path: '/b', body: [1, 2] } },
    { http: { method: 'POST', path: '/c', body: 'raw=${app.id}' } },
    { http: { method: 'POST', path: '/d', headers: { 'content-type': 'application/merge-patch+json' }, body: { a: 1 } } },
  ]);
  assert.equal(fake.http[0].headers['Content-Type'], 'application/json');
  assert.equal(fake.http[1].body, '[1,2]');
  assert.equal(fake.http[1].headers['Content-Type'], 'application/json');
  assert.equal(fake.http[2].body, 'raw=demo');
  assert.equal(fake.http[2].headers['Content-Type'], undefined);
  assert.equal(fake.http[3].headers['content-type'], 'application/merge-patch+json');
  assert.equal(fake.http[3].headers['Content-Type'], undefined);
});

test('body_from + set merges into a copy of a saved value', async () => {
  const { fake } = await run([
    { http: { path: '/config', save: { config: '$' } } },
    { http: { method: 'PUT', path: '/config', body_from: 'config', set: { 'oauth.enabled': true, 'oauth.clientId': '${sso.client_id}', 'new.deep.key': 'x' } } },
    { http: { method: 'PUT', path: '/again', body_from: 'config' } },
  ], (call) => call.method === 'GET' ? { body: { oauth: { enabled: false, scope: 'openid' }, other: [1] } } : {});
  assert.deepEqual(JSON.parse(fake.http[1].body!), {
    oauth: { enabled: true, scope: 'openid', clientId: 'youeye-app-demo' }, other: [1], new: { deep: { key: 'x' } },
  });
  // The saved value itself was not changed by set.
  assert.deepEqual(JSON.parse(fake.http[2].body!), { oauth: { enabled: false, scope: 'openid' }, other: [1] });
});

test('ok codes, failures and allow_failure', async () => {
  await run([{ http: { path: '/x', ok: [404] } }], () => ({ status: 404 }));
  await refused([{ http: { path: '/x' } }], /step 1 \(http\): GET \/x returned HTTP 500/, () => ({ status: 500 }));
  const { fake } = await run([
    { http: { path: '/fails', allow_failure: true, save: { token: 'token' } } },
    { http: { path: '/next' } },
  ], (call) => ({ status: call.path === '/fails' ? 500 : 200 }));
  assert.deepEqual(fake.http.map((call) => call.path), ['/fails', '/next']);
});

test('error messages leave out query strings (they may carry tokens)', async () => {
  const fake = await refused([{ http: { path: '/sso?api_key=${secret.admin_password}' } }], /GET \/sso returned HTTP 401$/, () => ({ status: 401 }));
  assert.equal(fake.http[0].path, '/sso?api_key=pw-secret');
});

test('file writes json, yaml, ini and text into the app\'s own container', async () => {
  const { fake } = await run([
    { file: { path: '/config/a.json', json: { issuer: '${sso.issuer}', n: 1 } } },
    { file: { container: 'worker', path: '/config/b.yaml', yaml: { list: ['${app.id}'] }, mode: '0600' } },
    { file: { path: '/config/c.ini', ini: { top: 1, auth: { client: '${sso.client_id}', on: true } } } },
    { file: { path: '/config/d.txt', text: 'hello ${app.name}\n', mode: '644' } },
  ]);
  assert.deepEqual(fake.files.map((file) => [file.container, file.path, file.mode]), [
    ['app-demo-main', '/config/a.json', '0644'],
    ['app-demo-worker', '/config/b.yaml', '0600'],
    ['app-demo-main', '/config/c.ini', '0644'],
    ['app-demo-main', '/config/d.txt', '0644'],
  ]);
  assert.deepEqual(JSON.parse(fake.files[0].data), { issuer: VARIABLES.sso!.issuer, n: 1 });
  assert.equal(fake.files[1].data, 'list:\n  - demo\n');
  assert.equal(fake.files[2].data, 'top=1\n\n[auth]\nclient=youeye-app-demo\non=true\n');
  assert.equal(fake.files[3].data, 'hello Demo\n');
});

test('file paths stay absolute without ".." after interpolation; INI values stay on one line', async () => {
  const dots = { ...VARIABLES, app: { ...VARIABLES.app!, id: '..' } };
  await refused([{ file: { path: '/config/${app.id}/x', text: 'x' } }], /not an absolute path/, undefined, { context: { variables: dots } });
  await refused([{ file: { path: '/config/x.ini', ini: { a: 'one\ntwo' } } }], /single-line/);
});

test('exec passes argv without a shell, with its timeout', async () => {
  const { fake } = await run([
    { exec: { run: ['php', 'occ', 'user_oidc:provider', '${identity.name}', '--clientsecret=${sso.client_secret}; rm -rf /'], timeout: 120 } },
    { exec: { container: 'worker', run: ['valkey-cli', 'FLUSHALL'] } },
  ]);
  assert.deepEqual(fake.execs[0], {
    container: 'app-demo-main',
    argv: ['php', 'occ', 'user_oidc:provider', 'YouEye ID', '--clientsecret=cs; rm -rf /'],
    timeoutMs: 120_000,
  });
  assert.deepEqual(fake.execs[1], { container: 'app-demo-worker', argv: ['valkey-cli', 'FLUSHALL'], timeoutMs: SETUP_LIMITS.execMs });
});

test('setup failures name the path as the file wrote it, never the substituted secret', async () => {
  const leaks = (error: Error) => !error.message.includes('pw-secret');
  await assert.rejects(run([{ http: { path: '/api/${secret.admin_password}' } }], () => ({ status: 500 })),
    (error: Error) => leaks(error) && /\/api\/\$\{secret\.admin_password\} returned HTTP 500/.test(error.message));
  await assert.rejects(run([{ http: { path: '/a', for_each: { path: '/list/${secret.admin_password}' } } }], () => ({ status: 404 })), leaks);
  await assert.rejects(run([{ wait: { http: '/ready/${secret.admin_password}', timeout: 1 } }], () => ({ status: 503 })), leaks);
  await assert.rejects(run([{ file: { path: '${secret.admin_password}', text: 'x' } }]), leaks);
});

test('a failing exec fails the step unless allow_failure', async () => {
  const fake = fakeTransport(() => undefined, { exitCode: (argv) => (argv[0] === 'bad' ? 3 : 0) });
  // The command's output is not repeated (it may hold the secrets it was given).
  await assert.rejects(runSetup(manifestWith([{ exec: { run: ['bad'] } }]), 'sso', context(fake)),
    (error: Error) => /bad exited with 3$/.test(error.message));
  assert.equal(await runSetup(manifestWith([{ exec: { run: ['bad'], allow_failure: true } }, { exec: { run: ['good'] } }]), 'sso', context(fake)), true);
  assert.deepEqual(fake.execs.map((call) => call.argv[0]), ['bad', 'bad', 'good']);
});

test('restart and sleep', async () => {
  const { fake } = await run([{ restart: 'worker' }, { sleep: 15 }]);
  assert.deepEqual(fake.restarts, ['app-demo-worker']);
  assert.deepEqual(fake.sleeps, [15_000]);
});

test('steps only reach this app\'s own containers', async () => {
  await refused([{ exec: { container: 'postgres', run: ['true'] } }], /"postgres" is not a container of demo/);
  await refused([{ restart: 'youeye-control' }], /not a container of demo/);
  await refused([{ file: { container: 'other', path: '/x', text: '' } }], /not a container of demo/);
  await refused([{ http: { container: 'worker', path: '/x' } }], /container "worker" has no port/);
  // Inherited names are not containers either.
  await refused([{ restart: 'constructor' }], /not a container of demo/);
});

// ─── URL safety (bug 2) ───────────────────────────────────

test('http paths are relative to the container; the runner builds the URL', async () => {
  const absolute = await refused([{ http: { path: 'http://169.254.169.254/latest' } }], /is not a path on the app/);
  assert.equal(absolute.http.length, 0);
  const evil = { ...VARIABLES, app: { ...VARIABLES.app!, id: '/evil.example' } };
  const injected = await refused([{ http: { path: '/${app.id}/x' } }], /is not a path on the app/, undefined, { context: { variables: evil } });
  assert.equal(injected.http.length, 0);
  const at = { ...VARIABLES, app: { ...VARIABLES.app!, id: '@evil.example' } };
  const { fake } = await run([{ http: { path: '/${app.id}' } }], undefined, { context: { variables: at } });
  assert.equal(new URL(fake.http[0].url).host, '10.10.0.2:8080');
  await refused([{ http: { path: '/../admin' } }], /is not a path on the app/);
});

test('a host name from the transport is refused; only an IP address is used', async () => {
  const fake = fakeTransport();
  fake.address = async () => 'evil.example';
  await assert.rejects(runSetup(manifestWith([{ http: { path: '/x' } }]), 'sso', context(fake)), /no IP address/);
  assert.equal(fake.http.length, 0);
});

test('a container address is used only inside its app network, never the gateway', () => {
  const network = { cidr: '10.76.0.32/27', gateway: '10.76.0.33' };
  assert.equal(checkAppAddress('10.76.0.34', network), '10.76.0.34');
  assert.throws(() => checkAppAddress('10.76.0.33', network), /gateway/);
  for (const outside of ['10.0.3.10', '10.76.0.32', '10.76.0.63', '10.76.0.64', '127.0.0.1']) {
    assert.throws(() => checkAppAddress(outside, network), /outside the app network/, outside);
  }
  assert.throws(() => checkAppAddress('fd00::1', network), /no IPv4 address/);
});

test('own containers are looked up on the app\'s network and the peer on the peer\'s; a checked address is reused', async () => {
  const fake = fakeTransport();
  const lookups: string[] = [];
  const address = fake.address.bind(fake);
  fake.address = async (container, network, iface) => {
    lookups.push(`${container}@${network}${iface ? `/${iface}` : ''}`);
    return address(container, network, iface);
  };
  await runSetup(manifestWith([
    { http: { path: '/a' } }, { http: { path: '/b' } }, { http: { path: '/c', target: 'peer' } },
  ], { for: 'connect:peer' }), 'connect:peer', context(fake, { peer: { appId: 'peer', container: 'app-peer', port: 9696 } }));
  assert.deepEqual(lookups, ['app-demo-main@demo', 'app-peer@peer']);
  assert.equal(fake.http.length, 3);
});

async function localServer(handler: (path: string) => { status: number; headers?: Record<string, string>; body?: string | Buffer }) {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '');
    const reply = handler(request.url ?? '');
    response.writeHead(reply.status, reply.headers);
    response.end(reply.body ?? '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, hits, port: (server.address() as AddressInfo).port };
}

test('redirects are never followed (real fetch against a local server)', async () => {
  const { server, hits, port } = await localServer((url) => url === '/start'
    ? { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }
    : url === '/local' ? { status: 301, headers: { Location: '/other' } } : { status: 200, body: '{}' });
  try {
    const transport: SetupTransport = { ...fakeTransport(), address: async () => '127.0.0.1', fetch: cappedFetch };
    const manifest = (steps: unknown[]) => manifestWith(steps, { containers: [container('main', port)] });
    await assert.rejects(runSetup(manifest([{ http: { path: '/start' } }]), 'sso', context(transport)),
      /GET \/start returned HTTP 302 \(redirects are not followed\)/);
    await assert.rejects(runSetup(manifest([{ http: { path: '/local' } }]), 'sso', context(transport)), /HTTP 301/);
    assert.equal(await runSetup(manifest([{ http: { path: '/start', ok: [302] } }]), 'sso', context(transport)), true);
    assert.deepEqual(hits, ['/start', '/local', '/start']);
  } finally {
    server.close();
  }
});

test('responses are size-capped', async () => {
  const big = Buffer.alloc(SETUP_LIMITS.responseBytes + 1, 'a');
  const { server, port } = await localServer((url) => url === '/declared'
    ? { status: 200, body: big }
    : { status: 200, headers: { 'Transfer-Encoding': 'chunked' }, body: big });
  try {
    const transport: SetupTransport = { ...fakeTransport(), address: async () => '127.0.0.1', fetch: cappedFetch };
    const manifest = (pathName: string) => manifestWith([{ http: { path: pathName } }], { containers: [container('main', port)] });
    await assert.rejects(runSetup(manifest('/declared'), 'sso', context(transport)), /larger than 4194304 bytes/);
    await assert.rejects(runSetup(manifest('/chunked'), 'sso', context(transport)), /larger than 4194304 bytes/);
  } finally {
    server.close();
  }
});

test('requests are time-limited', async () => {
  const server = createServer(() => { /* never answers */ });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;
    await assert.rejects(cappedFetch(url, { method: 'GET', headers: {}, timeoutMs: 200, maxBytes: 10 }), /timed out|abort/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a header with a line break is refused', async () => {
  const evil = { ...VARIABLES, secret: { admin_password: 'x\r\nHost: evil' } };
  await refused([{ http: { path: '/x', headers: { Authorization: '${secret.admin_password}' } } }], /line break/, undefined, { context: { variables: evil } });
});

// ─── Peer target ──────────────────────────────────────────

const PEER = { appId: 'peer', container: 'app-peer', port: 9696 };

test('target: peer reaches the approved peer\'s primary container in its connect file', async () => {
  const { fake } = await run([
    { http: { method: 'POST', path: '/api/v1/applications', target: 'peer', headers: { 'X-Api-Key': '${peer.api_key}' }, body: { url: '${self.url}' } } },
    { http: { method: 'POST', path: '/api/v3/downloadclient', body: { host: '${peer.host}' } } },
  ], undefined, {
    for: 'connect:peer',
    context: {
      peer: PEER,
      variables: { ...VARIABLES, peer: { id: 'peer', host: '10.20.0.2', url: 'http://10.20.0.2:9696', api_key: 'pk' }, self: { host: '10.10.0.2', url: 'http://10.10.0.2:8080', api_key: 'sk' } },
    },
  });
  assert.equal(fake.http[0].url, 'http://10.20.0.2:9696/api/v1/applications');
  assert.equal(fake.http[0].headers['X-Api-Key'], 'pk');
  assert.equal(fake.http[1].url, 'http://10.10.0.2:8080/api/v3/downloadclient');
});

test('target: peer is refused outside a connect file, for another peer, and with a container', async () => {
  const step = { http: { path: '/x', target: 'peer' } };
  const outside = await refused([step], /only allowed in a connect:<app> setup file/, undefined, { context: { peer: PEER } });
  assert.equal(outside.http.length, 0);
  await refused([step], /needs the approved connection to peer/, undefined, { for: 'connect:peer' });
  await refused([step], /needs the approved connection to peer/, undefined, { for: 'connect:peer', context: { peer: { ...PEER, appId: 'other' } } });
  await refused([{ http: { path: '/x', target: 'peer', container: 'main' } }], /primary container/, undefined, { for: 'connect:peer', context: { peer: PEER } });
});

// ─── Prototype pollution (bug 3) ──────────────────────────

function assertNotPolluted(): void {
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
}

test('set refuses __proto__, constructor and prototype in a key path', async () => {
  const save = { http: { path: '/c', save: { config: '$' } } };
  const respond: Responder = () => ({ body: { a: {} } });
  for (const key of ['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'a.prototype']) {
    await refused([save, { http: { method: 'PUT', path: '/c', body_from: 'config', set: { [key]: 'yes' } } }], /is not allowed/, respond);
  }
  await refused([{ http: { method: 'PUT', path: '/c', set: { 'x.constructor': 1 } } }], /"constructor" is not allowed/);
  assertNotPolluted();
});

test('saved JSON with __proto__, constructor or prototype keys is refused', async () => {
  for (const body of [
    '{"a":{"__proto__":{"polluted":1}}}',
    '{"a":{"constructor":{"prototype":{"polluted":1}}}}',
    '{"a":[{"prototype":1}]}',
  ]) {
    await refused([{ http: { path: '/c', save: { x: 'a' } } }], /is not allowed/, () => ({ body }));
    await refused([{ http: { path: '/c', save: { x: '$' } } }], /is not allowed/, () => ({ body }));
  }
  // A save path cannot walk into a prototype either.
  await refused([{ http: { path: '/c', save: { x: '__proto__' } } }], /is not allowed/, () => ({ body: {} }));
  // Nor a body inside the setup file itself.
  await refused([{ http: { method: 'POST', path: '/c', body: JSON.parse('{"__proto__":{"polluted":1}}') } }], /is not allowed/);
  assertNotPolluted();
});

test('${vars.__proto__…} and other prototype lookups are refused', async () => {
  for (const name of ['vars.__proto__', 'vars.__proto__.toString', 'vars.constructor', 'secret.constructor.name', 'app.prototype']) {
    const fake = await refused([{ http: { path: `/x/\${${name}}` } }], /is not allowed/);
    assert.equal(fake.http.length, 0);
  }
  // Also in conditions, which are otherwise lenient.
  await refused([{ http: { path: '/x', if: { empty: '${vars.__proto__}' } } }], /is not allowed/);
  // Inherited properties never resolve.
  await refused([{ http: { path: '/x/${vars.toString}' } }], /unresolved variable/);
  assertNotPolluted();
});

test('for_each items with __proto__ keys are refused', async () => {
  await refused([{ http: { method: 'DELETE', path: '/i/${item.id}', for_each: { path: '/i' } } }], /is not allowed/,
    (call) => call.method === 'GET' ? { body: '[{"id":1,"__proto__":{"polluted":1}}]' } : {});
  assertNotPolluted();
});

// ─── File deadline ────────────────────────────────────────

/** A fake transport on a fake clock: sleeps and requests move the clock. */
function clockedTransport(respond: Responder = () => undefined, requestMs = 0) {
  const clock = { now: 1_000_000 };
  const fake = fakeTransport(respond);
  const fetch = fake.fetch.bind(fake);
  const timeouts: number[] = [];
  Object.assign(fake, {
    now: () => clock.now,
    async sleep(ms: number) { fake.sleeps.push(ms); clock.now += ms; },
    async fetch(url: string, request: SetupHttpRequest) {
      timeouts.push(request.timeoutMs);
      clock.now += requestMs;
      return fetch(url, request);
    },
  });
  return { fake, clock, timeouts };
}

async function deadlineRun(steps: unknown[], transport: SetupTransport) {
  return runSetup(manifestWith(steps), 'sso', context(transport));
}

test('a setup file has one deadline for all its steps', async () => {
  assert.equal(SETUP_LIMITS.fileMs, 20 * 60_000);
  const { fake } = clockedTransport();
  await assert.rejects(deadlineRun([{ sleep: 600 }, { sleep: 600 }, { sleep: 600 }], fake),
    (error: unknown) => error instanceof SetupStepError && error.step === 2 && /longer than 20 minutes/.test(error.message));
  assert.deepEqual(fake.sleeps, [600_000]);
});

test('allow_failure never skips the deadline; requests get only the time left', async () => {
  const { fake, timeouts } = clockedTransport(undefined, 21 * 60_000);
  await assert.rejects(deadlineRun([{ http: { path: '/slow', allow_failure: true } }, { http: { path: '/never' } }], fake),
    (error: unknown) => error instanceof SetupStepError && error.step === 1 && /longer than 20 minutes/.test(error.message));
  assert.deepEqual(fake.http.map((call) => call.path), ['/slow']);
  assert.equal(timeouts[0], SETUP_LIMITS.requestMs);

  // 6 s before the deadline a request may take 6 s, not 30 s.
  const late = clockedTransport();
  await deadlineRun([{ sleep: 597 }, { sleep: 597 }, { http: { path: '/last' } }], late.fake);
  assert.equal(late.timeouts[0], 6_000);
});

test('for_each items count toward the file deadline and are capped', async () => {
  const list = Array.from({ length: SETUP_LIMITS.forEachItems }, (_, id) => ({ id }));
  const { fake } = clockedTransport((call) => (call.path === '/items' ? { body: list } : {}), 3_000);
  await assert.rejects(deadlineRun([{ http: { method: 'DELETE', path: '/items/${item.id}', for_each: { path: '/items' } } }], fake),
    /longer than 20 minutes/);
  const deletes = fake.http.filter((call) => call.method === 'DELETE').length;
  assert.ok(deletes > 0 && deletes < SETUP_LIMITS.forEachItems, `${deletes} items ran`);
  await refused([{ http: { method: 'DELETE', path: '/i/${item.id}', for_each: { path: '/i' } } }], /more than 500 items/,
    () => ({ body: Array.from({ length: SETUP_LIMITS.forEachItems + 1 }, (_, id) => ({ id })) }));
});

// ─── for_each, if, remove ─────────────────────────────────

test('for_each GETs the list and runs once per item matching where', async () => {
  const { fake } = await run([
    { http: {
      method: 'DELETE', path: '/api/v1/${item.name}', headers: { Authorization: 'Bearer t' },
      for_each: { path: '/api/v1/providers', items: 'data.providers', where: { type: 'OAUTH2', title: '${identity.name}' } },
    } },
  ], (call) => call.method === 'GET' ? { body: { data: { providers: [
    { name: 'providers/1', type: 'OAUTH2', title: 'YouEye ID' },
    { name: 'providers/2', type: 'OAUTH2', title: 'Other' },
    { name: 'providers/3', type: 'LDAP', title: 'YouEye ID' },
    { name: 'providers/4', type: 'OAUTH2', title: 'YouEye ID' },
  ] } } } : {});
  assert.deepEqual(fake.http.map((call) => `${call.method} ${call.path}`), [
    'GET /api/v1/providers', 'DELETE /api/v1/providers/1', 'DELETE /api/v1/providers/4',
  ]);
  assert.equal(fake.http[0].headers.Authorization, 'Bearer t');
});

test('for_each with a missing or empty list does nothing; numbers match by value', async () => {
  const missing = await run([{ http: { method: 'DELETE', path: '/x/${item.id}', for_each: { path: '/x', items: 'list' } } }], () => ({ body: {} }));
  assert.equal(missing.fake.http.length, 1);
  const numbers = await run([{ http: { method: 'DELETE', path: '/x/${item.id}', for_each: { path: '/x', where: { port: 8080 } } } }],
    (call) => call.method === 'GET' ? { body: [{ id: 1, port: 8080 }, { id: 2, port: 9090 }] } : {});
  assert.deepEqual(numbers.fake.http.map((call) => call.path), ['/x', '/x/1']);
  await refused([{ http: { path: '/x/${item.id}', for_each: { path: '/x' } } }], /not an array/, () => ({ body: { a: 1 } }));
});

test('if: equals, not_equals, empty, not_empty (unsaved values are empty)', async () => {
  const { fake } = await run([
    { http: { path: '/token', save: { token: 'token' }, allow_failure: true } },
    { http: { path: '/a', if: { equals: ['${vars.token}', ''] } } },
    { http: { path: '/b', if: { not_equals: ['${vars.token}', ''] } } },
    { http: { path: '/c', if: { empty: '${vars.token}' } } },
    { http: { path: '/d', if: { not_empty: '${vars.token}' } } },
    { http: { path: '/e', if: { equals: ['${sso.client_id}', 'youeye-app-demo'] } } },
  ], (call) => call.path === '/token' ? { status: 401 } : {});
  assert.deepEqual(fake.http.map((call) => call.path), ['/token', '/a', '/c', '/e']);
});

test('remove runs the remove steps instead of steps', async () => {
  const { fake, ran } = await run([{ exec: { run: ['install'] } }], undefined, {
    remove: [{ exec: { run: ['uninstall'] } }], context: { remove: true },
  });
  assert.equal(ran, true);
  assert.deepEqual(fake.execs.map((call) => call.argv), [['uninstall']]);
});

// ─── Connection wiring ────────────────────────────────────

function installed(appId: string, manifest: AppManifest): InstallMetadata {
  return {
    appId, subdomain: appId, domain: 'box.test', enableSSO: false, installedAt: 'now', integration: 'basic',
    containers: manifest.containers.map((spec) => ({ name: spec.name, containerName: `app-${appId}`, type: 'oci' as const })),
  };
}

function wiringFixture(approved: boolean) {
  const consumer = appFixture({
    id: 'demo',
    secrets: { api_key: { kind: 'key' } },
    api_key: { secret: 'api_key' },
    connects: [{ app: 'peer', name: 'Peer', setup: 'setup/connect-peer.yaml' }],
  }, {
    'setup/connect-peer.yaml': {
      schema: 'youeye.setup.v1',
      for: 'connect:peer',
      steps: [
        { http: { method: 'POST', path: '/api/v1/applications', target: 'peer', headers: { 'X-Api-Key': '${peer.api_key}' }, body: { prowlarrUrl: '${peer.url}', baseUrl: '${self.url}', apiKey: '${self.api_key}' } } },
        { http: { method: 'POST', path: '/api/v3/downloadclient', headers: { 'X-Api-Key': '${self.api_key}' }, body: { host: '${peer.host}' } } },
      ],
      remove: [
        { http: { method: 'DELETE', path: '/api/v1/applications/7', target: 'peer', headers: { 'X-Api-Key': '${peer.api_key}' } } },
      ],
    },
  });
  // The peer's key lives in a secret with another name: the frozen manifest says which.
  const peer = appFixture({ id: 'peer', port: 9696, env: { KEY: '${secret.admin_password}' }, api_key: { secret: 'admin_password' } });
  const transport = fakeTransport();
  const store: Record<string, Record<string, string>> = {
    demo: { api_key: 'demo-key' },
    peer: { admin_password: 'peer-key', api_key: 'not-this-one' },
  };
  const secretReads: string[] = [];
  const deps: WiringDeps = {
    readManifest: async (appId) => (appId === 'demo' ? consumer : peer),
    readMetadata: async (appId) => installed(appId, appId === 'demo' ? consumer : peer),
    isApproved: async () => approved,
    readSecret: async (appId, name) => { secretReads.push(`${appId}/${name}`); return store[appId]?.[name] ?? null; },
    transport,
  };
  return { deps, transport, secretReads };
}

test('wiring runs the consumer\'s connect file with peer/self values from both installed apps', async () => {
  const { deps, transport, secretReads } = wiringFixture(true);
  assert.deepEqual(await runConnectionWiring('demo', 'peer', deps), { ran: true });
  const [toPeer, toSelf] = transport.http;
  assert.equal(toPeer.url, 'http://10.20.0.2:9696/api/v1/applications');
  assert.equal(toPeer.headers['X-Api-Key'], 'peer-key');
  // The peer calls the consumer back on the consumer's connection NIC; the consumer's own steps use its own address.
  assert.deepEqual(JSON.parse(toPeer.body!), { prowlarrUrl: 'http://10.20.0.2:9696', baseUrl: 'http://10.20.0.7:8080', apiKey: 'demo-key' });
  assert.equal(toSelf.url, 'http://10.10.0.2:8080/api/v3/downloadclient');
  assert.deepEqual(JSON.parse(toSelf.body!), { host: '10.20.0.2' });
  assert.deepEqual([...new Set(secretReads)].sort(), ['demo/api_key', 'peer/admin_password']);
  assert.equal(transport.execs.length, 0);
});

test('installed setups use the container names of the install record, never derived ones', () => {
  const manifest = { containers: [container('main', 8080), container('worker')] };
  const containers = [
    { name: 'main', containerName: 'app-demo-renamed', type: 'oci' as const },
    { name: 'worker', containerName: 'app-demo-w2', type: 'oci' as const },
  ];
  assert.deepEqual(setupContainers(manifest, { appId: 'demo', containers }), { main: 'app-demo-renamed', worker: 'app-demo-w2' });
  assert.throws(() => setupContainers(manifest, { appId: 'demo', containers: containers.slice(0, 1) }),
    /install record of demo has no container "worker"/);
});

test('removing a connection runs the consumer\'s connect file remove: steps', async () => {
  const { deps, transport } = wiringFixture(true);
  assert.deepEqual(await runConnectionWiring('demo', 'peer', deps, { remove: true }), { ran: true });
  assert.deepEqual(transport.http.map((call) => `${call.method} ${call.url}`), ['DELETE http://10.20.0.2:9696/api/v1/applications/7']);
  assert.equal(transport.http[0].headers['X-Api-Key'], 'peer-key');
});

test('a wiring failure is reported without its details', async () => {
  const { deps, transport } = wiringFixture(true);
  transport.fetch = async () => { throw new Error('connect ECONNREFUSED secret-token-123'); };
  const result = await runConnectionWiring('demo', 'peer', deps);
  assert.deepEqual(result, { ran: false, error: 'Could not wire demo → peer' });
});

test('wiring is refused for a connection that is not approved', async () => {
  const { deps, transport } = wiringFixture(false);
  assert.deepEqual(await runConnectionWiring('demo', 'peer', deps), { ran: false, error: 'connection demo → peer is not approved' });
  assert.equal(transport.http.length, 0);
});

// ─── The real converted setup files (Market plan4) ────────

const MARKET = path.join(root, 'tests/fixtures/market-setup');

function marketApp(id: string): AppManifest {
  const dir = path.join(MARKET, id);
  const setups: Record<string, string> = {};
  if (existsSync(path.join(dir, 'setup'))) {
    for (const name of readdirSync(path.join(dir, 'setup'))) setups[`setup/${name}`] = readFileSync(path.join(dir, 'setup', name), 'utf8');
  }
  return loadApp({ manifest: readFileSync(path.join(dir, 'youeye-app.yaml'), 'utf8'), setups });
}

/** A scripted fake of the apps' APIs: just enough for each file's reads. */
const scriptedApps: Responder = (call) => {
  const route = `${call.method} ${call.path.split('?')[0]}`;
  switch (route) {
    case 'POST /login': return { body: { user: { token: 'abs-token' } } };
    case 'POST /api/auth/login': return { body: { accessToken: 'immich-token' } };
    case 'GET /api/system-config': return { body: { oauth: { enabled: false, clientId: 'youeye-app-demo', buttonText: 'x' }, ffmpeg: { crf: 23 } } };
    case 'POST /Users/AuthenticateByName': return { body: { AccessToken: 'jf-token' } };
    case 'GET /Repositories': return { body: [] };
    case 'POST /api/v1/auth/signin': return { body: { accessToken: 'memos-token' } };
    case 'GET /api/v1/identity-providers': return { body: { identityProviders: [
      { name: 'identity-providers/1', type: 'OAUTH2', title: 'YouEye ID' },
      { name: 'identity-providers/2', type: 'OAUTH2', title: 'Other' },
    ] } };
    case 'GET /api/v1/applications': return { body: [{ id: 7, name: 'Sonarr' }, { id: 8, name: 'Radarr' }] };
    case 'GET /api/v3/downloadclient': return { body: [{ id: 3, name: 'qBittorrent' }] };
    default: return { status: call.method === 'POST' ? 201 : 200, body: {} };
  }
};

const SUPPORTED = new Set(['wait', 'http', 'file', 'exec', 'restart', 'sleep']);

test('every real converted setup file runs against a scripted fake app', async () => {
  const peers: Record<string, AppManifest> = { prowlarr: marketApp('prowlarr'), qbittorrent: marketApp('qbittorrent') };
  const files: string[] = [];
  for (const id of readdirSync(MARKET).sort()) {
    const manifest = marketApp(id);
    for (const file of manifest.setups) {
      for (const step of [...file.steps, ...(file.remove ?? [])]) assert.ok(SUPPORTED.has(Object.keys(step)[0]));
      for (const remove of file.remove ? [false, true] : [false]) {
        const transport = fakeTransport(scriptedApps);
        const connected = file.for.startsWith('connect:') ? file.for.slice('connect:'.length) : undefined;
        const peerManifest = connected ? peers[connected] : undefined;
        const ctx: SetupRunContext = {
          appId: id,
          containers: Object.fromEntries(manifest.containers.map((spec) => [spec.name, manifest.containers.length > 1 ? `app-${id}-${spec.name}` : `app-${id}`])),
          variables: {
            ...VARIABLES,
            app: { ...VARIABLES.app!, id, fqdn: `${id}.box.test` },
            secret: Object.fromEntries(manifest.secrets.map((secret) => [secret.name, `${secret.name}-value`])),
            ...(connected ? {
              peer: { id: connected, host: '10.20.0.2', url: 'http://10.20.0.2:9696', api_key: 'peer-key' },
              self: { host: '10.10.0.2', url: 'http://10.10.0.2:8989', api_key: 'self-key' },
            } : {}),
          },
          peer: connected && peerManifest ? { appId: connected, container: 'app-peer', port: peerManifest.containers[0].port! } : undefined,
          remove,
          transport,
        };
        assert.equal(await runSetup(manifest, file.for as SetupPurpose, ctx), true, `${id} ${file.name}`);
        files.push(`${id}/${file.name}${remove ? ' (remove)' : ''}`);

        // Spot checks of what each file did.
        if (id === 'immich' && !remove) {
          const put = transport.http.find((call) => call.method === 'PUT')!;
          const body = JSON.parse(put.body!);
          assert.equal(body.oauth.enabled, true);
          assert.equal(body.oauth.clientId, 'youeye-app-demo');
          assert.deepEqual(body.ffmpeg, { crf: 23 });
          assert.equal(put.headers.Authorization, 'Bearer immich-token');
        }
        if (id === 'immich' && remove) {
          assert.equal(JSON.parse(transport.http.find((call) => call.method === 'PUT')!.body!).oauth.enabled, false);
        }
        if (id === 'memos') {
          // steps: every OAUTH2 provider; remove: only YouEye ID's.
          assert.deepEqual(transport.http.filter((call) => call.method === 'DELETE').map((call) => call.path),
            remove ? ['/api/v1/identity-providers/1'] : ['/api/v1/identity-providers/1', '/api/v1/identity-providers/2']);
        }
        if (id === 'nextcloud' && file.for === 'url-change') {
          assert.deepEqual(transport.execs.at(-1), { container: 'app-nextcloud-valkey', argv: ['valkey-cli', 'FLUSHALL'], timeoutMs: SETUP_LIMITS.execMs });
          assert.ok(transport.execs.some((call) => call.argv.includes('--value=nextcloud.box.test')));
        }
        if (connected === 'prowlarr') {
          const deleted = transport.http.filter((call) => call.method === 'DELETE');
          assert.equal(deleted.length, 1);
          assert.equal(deleted[0].url, `http://10.20.0.2:9696/api/v1/applications/${id === 'sonarr' ? 7 : 8}`);
          assert.ok(transport.http.every((call) => call.host === '10.20.0.2'));
        }
        if (connected === 'qbittorrent') {
          assert.ok(transport.http.every((call) => call.host !== '10.20.0.2'), 'qBittorrent wiring only calls the consumer');
          assert.deepEqual(transport.http.filter((call) => call.method === 'DELETE').map((call) => call.path), ['/api/v3/downloadclient/3']);
        }
      }
    }
  }
  assert.deepEqual(files, [
    'audiobookshelf/setup/sso.yaml', 'audiobookshelf/setup/sso.yaml (remove)',
    'immich/setup/sso.yaml', 'immich/setup/sso.yaml (remove)',
    'jellyfin/setup/sso.yaml', 'jellyfin/setup/sso.yaml (remove)',
    'memos/setup/sso.yaml', 'memos/setup/sso.yaml (remove)',
    'nextcloud/setup/sso.yaml', 'nextcloud/setup/sso.yaml (remove)', 'nextcloud/setup/url-change.yaml',
    'qbittorrent/setup/install.yaml',
    'radarr/setup/connect-prowlarr.yaml', 'radarr/setup/connect-qbittorrent.yaml',
    'sonarr/setup/connect-prowlarr.yaml', 'sonarr/setup/connect-qbittorrent.yaml',
  ]);
});

test('unwiring a connect file without remove: steps does nothing and looks up no addresses', async () => {
  const { deps: withRemove, transport } = wiringFixture(true);
  const deps: WiringDeps = {
    ...withRemove,
    readManifest: async (appId) => {
      const manifest = await withRemove.readManifest(appId);
      return { ...manifest, setups: manifest.setups.map((file) => ({ ...file, remove: undefined })) };
    },
  };
  let lookups = 0;
  const address = transport.address.bind(transport);
  transport.address = async (...args: Parameters<typeof address>) => { lookups++; return address(...args); };
  assert.deepEqual(await runConnectionWiring('demo', 'peer', deps, { remove: true }), { ran: false });
  assert.equal(lookups, 0);
  assert.equal(transport.http.length, 0);
});
