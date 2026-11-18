// Run: node --import tsx --test tests/setup-host-paths.spec.ts
// The setup surface (box IP, youeye.local) serves onboarding only: claim and setup
// before setup completes, then just setup-complete and the owner reset.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { requestIsPlainHttp, setupHostAllows } from '../src/lib/auth/setup-host-paths';

test('before setup completes the setup surface serves claim and setup', () => {
  for (const [path, method] of [
    ['/login', 'GET'], ['/setup', 'GET'], ['/api/appliance/claim', 'POST'], ['/api/setup/run', 'POST'],
    ['/api/setup/names/start', 'POST'], ['/api/tls/youeye-names/preview', 'POST'], ['/api/deploy/infrastructure', 'GET'],
    ['/api/auth/csrf', 'GET'], ['/api/auth/login', 'POST'], ['/api/ping', 'GET'], ['/settings/reset-owner', 'GET'],
    ['/api/dns-providers/cloudflare/validate', 'POST'], ['/api/setup/ca-fingerprint', 'GET'],
  ]) assert.equal(setupHostAllows(path, method, false), true, `${method} ${path}`);
  for (const path of ['/settings', '/market', '/api/apps', '/identity/login', '/api/ui-settings/language', '/oauth/authorize']) {
    assert.equal(setupHostAllows(path, 'GET', false), false, path);
  }
});

test('after setup completes only setup-complete and the owner reset remain', () => {
  const allowed: Array<[string, string]> = [
    ['/setup-complete', 'GET'], ['/api/ping', 'GET'], ['/api/auth/csrf', 'GET'], ['/api/appliance/handoff', 'POST'],
    ['/api/setup/config', 'GET'], ['/api/setup/server-address', 'GET'], ['/api/setup/ca-cert', 'GET'],
    ['/api/setup/ca-fingerprint', 'GET'], ['/api/setup/profile', 'GET'], ['/api/setup/status', 'GET'],
    ['/api/branding/favicon', 'GET'], ['/reset-owner', 'GET'], ['/settings/reset-owner', 'GET'],
    ['/settings/api/auth/reset-owner', 'POST'], ['/api/auth/reset-owner', 'POST'], ['/api/tls/upload', 'POST'],
  ];
  for (const [path, method] of allowed) assert.equal(setupHostAllows(path, method, true), true, `${method} ${path}`);
  const refused: Array<[string, string]> = [
    ['/login', 'GET'], ['/setup', 'GET'], ['/api/auth/login', 'POST'], ['/api/auth/sso', 'GET'], ['/api/auth/callback', 'GET'],
    ['/api/appliance/claim', 'GET'], ['/api/appliance/claim', 'POST'], ['/api/setup/run', 'POST'], ['/api/setup/config', 'PATCH'],
    ['/api/setup/config', 'PUT'], ['/api/setup/names/start', 'POST'], ['/api/setup/restore', 'POST'], ['/api/deploy/infrastructure', 'GET'],
    ['/api/tls/acme', 'POST'], ['/api/tls/youeye-names/preview', 'POST'], ['/api/dns-providers/cloudflare/validate', 'POST'],
    ['/settings', 'GET'], ['/api/apps', 'GET'],
  ];
  for (const [path, method] of refused) assert.equal(setupHostAllows(path, method, true), false, `${method} ${path}`);
});

test('the scheme comes from Caddy\'s X-Forwarded-Proto', () => {
  assert.equal(requestIsPlainHttp('http', 'http://youeye.local/'), true);
  assert.equal(requestIsPlainHttp('https', 'http://youeye.local/'), false);
  assert.equal(requestIsPlainHttp('http, https', 'https://youeye.local/'), true);
  assert.equal(requestIsPlainHttp(null, 'http://192.168.1.50/'), true);
  assert.equal(requestIsPlainHttp(null, 'https://192.168.1.50/'), false);
});

async function withMiddleware(setupCompleted: boolean, run: (call: (path: string, init?: { method?: string; host?: string; proto?: string }) => Promise<Response>) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/setup/config')) return Response.json({ setup_completed: setupCompleted });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  // A fresh module per completion state: the middleware caches setup completion.
  const { proxy } = await import(`../src/proxy.ts?completed=${setupCompleted}`);
  try {
    await run(async (path, init = {}) => {
      const headers = new Headers({ host: init.host ?? 'youeye.local' });
      if (init.proto) headers.set('x-forwarded-proto', init.proto);
      return proxy(new NextRequest(`http://${init.host ?? 'youeye.local'}${path}`, { method: init.method ?? 'GET', headers }));
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('middleware: password sign-in over plain HTTP on the setup surface is refused, before and after setup', async () => {
  for (const completed of [false, true]) {
    await withMiddleware(completed, async (call) => {
      for (const path of ['/api/auth/login', '/settings/api/auth/login']) {
        const response = await call(path, { method: 'POST', proto: 'http' });
        assert.equal(response.status, 403, `${completed} ${path}`);
      }
    });
  }
  await withMiddleware(false, async (call) => {
    const response = await call('/api/auth/login', { method: 'POST', proto: 'https' });
    assert.notEqual(response.status, 403, 'HTTPS password sign-in keeps working before setup');
    // A named host is not the setup surface: the HTTP rule there is the normal SSO rule.
    const named = await call('/api/auth/login', { method: 'POST', proto: 'http', host: 'control.box.example.test' });
    assert.equal(named.status, 403);
  });
});

test('middleware: after setup the setup surface sends everything else to setup-complete', async () => {
  await withMiddleware(true, async (call) => {
    const login = await call('/login', { proto: 'http' });
    assert.equal(login.status, 307);
    assert.equal(new URL(login.headers.get('location')!).pathname, '/setup-complete');
    const setup = await call('/setup', { proto: 'http' });
    assert.equal(new URL(setup.headers.get('location')!).pathname, '/setup-complete');
    const claim = await call('/api/appliance/claim', { method: 'POST', proto: 'http' });
    assert.equal(claim.status, 404);
    const run = await call('/api/setup/run', { method: 'POST', proto: 'http' });
    assert.equal(run.status, 404);
    const done = await call('/setup-complete', { proto: 'http' });
    assert.equal(done.headers.get('location'), null);
    assert.equal(done.headers.get('x-middleware-next'), '1');
    const fingerprint = await call('/api/setup/ca-fingerprint', { proto: 'http' });
    assert.equal(fingerprint.headers.get('x-middleware-next'), '1');
    const handoff = await call('/api/appliance/handoff', { method: 'POST', proto: 'http' });
    assert.equal(handoff.headers.get('x-middleware-next'), '1');
  });
  await withMiddleware(false, async (call) => {
    const login = await call('/login', { proto: 'http' });
    assert.equal(login.headers.get('x-middleware-next'), '1', 'claim works over HTTP before setup');
    const claim = await call('/api/appliance/claim', { method: 'POST', proto: 'http' });
    assert.equal(claim.headers.get('x-middleware-next'), '1');
    const settings = await call('/settings', { proto: 'http' });
    assert.equal(new URL(settings.headers.get('location')!).pathname, '/login');
  });
});
