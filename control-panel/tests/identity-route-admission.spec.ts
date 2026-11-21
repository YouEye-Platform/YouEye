import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// POST /api/identity/route renames the YouEye ID host: on a set-up box that is a full reconfigure. It asks for the
// CSRF token and runs as a user operation, like /api/setup/reconfigure and /api/tls/domain/apply. The route's real
// body runs here; sessions, settings, Caddy and the reconfigure are stand-ins.
const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function load(path: string, dependencies: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected test dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function fixture() {
  const state = {
    session: { isAdmin: true } as { isAdmin: boolean } | null,
    cliToken: false,
    setupCompleted: true,
    order: [] as string[],
    lock: async (work: () => unknown) => { state.order.push('operation-lock'); return work(); },
  };
  const next = { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
  const admission = { withUserOperationLockWait: (work: () => unknown) => state.lock(work) };
  class AppLifecycleBusyError extends Error { constructor() { super('executor lock is busy'); this.name = 'AppLifecycleBusyError'; } }
  const busy = load('src/lib/http/lifecycle-busy.ts', {
    'next/server': next,
    '@/lib/market/update-admission': { ...admission, AppLifecycleBusyError },
    '@/lib/incus/app-network-ipam': { AppNetworkLockBusyError: class extends Error {} },
  });
  const route = load('src/app/api/identity/route/route.ts', {
    'next/server': next,
    '@/lib/auth/session': {
      getSession: async () => state.session,
      // The real check: the CLI token is the credential; a browser needs the token of its cookie.
      verifyCSRFToken: async (token: string) => state.cliToken || token === 'cookie-token',
    },
    '@/lib/settings': { settingsService: {
      getRaw: async () => ({ domain: 'box.example', subdomains: { ui: 'home' }, setup_completed: state.setupCompleted }),
      setRaw: async () => { state.order.push('settings'); },
    } },
    '@/lib/caddy/client': { ensureIdentityRoute: async () => { state.order.push('caddy-route'); } },
    '@/lib/identity/config': { getIdentityConfig: async () => ({ containerName: 'youeye-control', port: 3001 }) },
    '@/lib/reconfigure': { reconfigure: async (request: { subdomains: Record<string, string> }) => {
      state.order.push(`reconfigure:${request.subdomains.identity}`);
    } },
    '@/lib/market/update-admission': admission,
    '@/lib/http/lifecycle-busy': busy,
  });
  const post = (headers: Record<string, string> = {}): Promise<Response> => route.POST(new Request('http://control/api/identity/route', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ identitySubdomain: 'id' }),
  }));
  return { state, post, AppLifecycleBusyError };
}

test('a request without the CSRF token is refused before anything changes', async () => {
  const f = fixture();
  for (const headers of [{}, { 'X-CSRF-Token': 'wrong' }]) {
    const response = await f.post(headers);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Invalid CSRF token' });
  }
  assert.deepEqual(f.state.order, []);
  f.state.session = { isAdmin: false };
  assert.equal((await f.post({ 'X-CSRF-Token': 'cookie-token' })).status, 403);
  assert.deepEqual(f.state.order, []);
});

test('a browser with its token, and the CLI with the CLI token, rename under the operation lock', async () => {
  const browser = fixture();
  const answer = await browser.post({ 'X-CSRF-Token': 'cookie-token' });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    ok: true, host: 'id.box.example', subdomains: { ui: 'home', identity: 'id' }, restartScheduled: true,
  });
  assert.deepEqual(browser.state.order, ['operation-lock', 'reconfigure:id']);

  // The Spine CLI sends X-CLI-Token and X-CSRF-Token: cli (spine/internal/controlapi/client.go).
  const cli = fixture();
  cli.state.cliToken = true;
  assert.equal((await cli.post({ 'X-CLI-Token': 'token', 'X-CSRF-Token': 'cli' })).status, 200);
  assert.deepEqual(cli.state.order, ['operation-lock', 'reconfigure:id']);
});

test('a lock still busy after the wait is 409, not a 500, and nothing is reconfigured', async () => {
  const f = fixture();
  f.state.lock = async () => { throw new f.AppLifecycleBusyError(); };
  const response = await f.post({ 'X-CSRF-Token': 'cookie-token' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'operation_in_progress');
  assert.deepEqual(f.state.order, []);
});

test('before setup ends the route still only saves the name and its Caddy route', async () => {
  const f = fixture();
  f.state.setupCompleted = false;
  assert.equal((await f.post({ 'X-CSRF-Token': 'cookie-token' })).status, 200);
  assert.deepEqual(f.state.order, ['settings', 'caddy-route']);
});
