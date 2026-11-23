/**
 * The installed-app admission reconcile (`reconcileInstalledAdmission`, every Control Panel start) writes Caddy only
 * when an app's gate differs. It compared the handlers as built with the ones Caddy returns (keys sorted, and since
 * YE-138 the forward-auth check carries the Control Panel retry), so they never matched and every start rewrote Caddy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { buildForwardAuthHandler, controlPanelDials } from '../src/lib/caddy/client';
import * as servers from '../src/lib/caddy/servers';

function loadModule(file: string, mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(process.cwd(), 'src/lib', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, require(name: string) {
    if (name in mocks) return mocks[name];
    // Objects built inside the vm context have its own Object prototype, which isDeepStrictEqual compares: the
    // read-back check compares them as plain JSON, as Caddy returns them.
    if (name === 'node:util') {
      return { isDeepStrictEqual: (a: unknown, b: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))) };
    }
    return new Proxy({}, { get: (_target, property) => {
      if (property === '__esModule') return true;
      return () => { throw Error(`Unexpected effect: ${name}.${String(property)}`); };
    } });
  } });
  return exports;
}

const CONTROL_IP = '10.45.18.16';
const ID_DIAL = `${CONTROL_IP}:3001`;
const HEADERS = ['X-YouEye-Username', 'X-YouEye-Groups', 'X-YouEye-Email', 'X-YouEye-Name', 'X-YouEye-Uid'];
const meta = { appId: 'notes', subdomain: 'notes', domain: 'box.test', lifecycleState: 'active',
  containers: [{ containerName: 'app-notes' }] };

/** The app's route as Caddy returns it after a write: keys sorted, forward auth with or without the retry. */
function caddyConfig(withRetry: boolean) {
  const gate = buildForwardAuthHandler(ID_DIAL, '/forward-auth/caddy', HEADERS) as unknown as Record<string, unknown>;
  if (withRetry) gate.load_balancing = { try_duration: '10s', try_interval: '250ms' };
  const route = {
    '@id': 'app-notes', match: [{ host: ['notes.box.test'] }],
    handle: [
      { handler: 'headers', request: { delete: ['X-YouEye-App', 'X-YouEye-User', ...HEADERS] } },
      gate,
      { handler: 'reverse_proxy', upstreams: [{ dial: '10.45.18.40:3000' }] },
    ],
  };
  return JSON.parse(servers.canonicalJSON({ apps: { http: { servers: { srv0: { listen: [':443'], routes: [route] } } } } }));
}

async function reconcile(config: Record<string, any>) {
  const writes: unknown[] = [];
  const lifecycle = loadModule('admission/lifecycle.ts', {
    './store': { ensureAppAdmission: async () => ({}) },
    '@/lib/identity/store': { ensureIdentitySchema: async () => {}, identityCommand: async () => {} },
    '@/lib/market/metadata': { listInstalledApps: async () => [structuredClone(meta)] },
    '@/lib/caddy/client': {
      getConfig: async () => structuredClone(config),
      setConfig: async (value: Record<string, any>) => {
        // What the real setConfig does to every write (YE-138).
        servers.applyControlPanelRetry(value, controlPanelDials(CONTROL_IP));
        writes.push(structuredClone(value));
        config = JSON.parse(servers.canonicalJSON(value));
      },
      buildForwardAuthHandler,
      currentControlPanelDials: async () => controlPanelDials(CONTROL_IP),
      resolveCaddyUpstreamDial: async () => ID_DIAL,
    },
    '@/lib/caddy/servers': servers,
    '@/lib/identity/config': { getIdentityConfig: async () => ({ containerName: 'youeye-control', port: 3001 }) },
    '@/lib/incus/container-ip': { getContainerIP: async () => '10.45.18.40' },
    '@/lib/market/update-admission': { withAppLifecycle: async () => undefined },
    '@/lib/caddy/scoped-grant-admission': { scopedGrantHandlers: () => null },
  });
  await lifecycle.reconcileInstalledAdmission();
  return { writes, config: () => config };
}

test('a converged box: the app gate as Caddy keeps it is not rewritten at start', async () => {
  const { writes } = await reconcile(caddyConfig(true));
  assert.equal(writes.length, 0);
});

test('a box from before YE-138: one write gives the gate the retry, and the next start writes nothing', async () => {
  const first = await reconcile(caddyConfig(false));
  assert.equal(first.writes.length, 1);
  const gate = first.config().apps.http.servers.srv0.routes[0].handle[1];
  assert.deepEqual(gate.load_balancing, { try_duration: '10s', try_interval: '250ms' });
  const second = await reconcile(first.config());
  assert.equal(second.writes.length, 0);
});
