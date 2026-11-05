import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require('next/server');
const root = process.env.CONTROL_PANEL_ROOT || process.cwd();

function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const api: any = {};
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    ...globals, exports: api, require(id: string) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw Error(`Unexpected dependency/effect: ${id}`);
    },
  });
  return api;
}

test('saved setup appearance requires an administrator before reading the bridge', async () => {
  for (const session of [null, { isAdmin: false }]) {
    let reads = 0;
    const route = load('src/app/api/setup/branding/route.ts', {
      'next/server': { NextResponse },
      '@/lib/auth/session': { getSession: async () => session },
      '@/app/api/ui/branding/route': { GET: async () => { reads++; throw Error('Must not read'); } },
    });
    assert.equal((await route.GET()).status, 403);
    assert.equal(reads, 0);
    assert.equal(route.PUT, undefined);
    assert.equal(route.PATCH, undefined);
    assert.equal(route.POST, undefined);
  }
});

test('setup appearance preserves saved revisions and bridge failures without inventing defaults', async () => {
  for (const response of [
    NextResponse.json({ site_name: 'Saved title', site_name_style: { mytitleRevision: 'revision-3' } }),
    NextResponse.json({ error: 'Bridge token unavailable' }, { status: 500 }),
    NextResponse.json({ error: 'UI unreachable' }, { status: 502 }),
  ]) {
    let reads = 0;
    const route = load('src/app/api/setup/branding/route.ts', {
      'next/server': { NextResponse },
      '@/lib/auth/session': { getSession: async () => ({ isAdmin: true, authMethod: 'setup' }) },
      '@/app/api/ui/branding/route': { GET: async () => { reads++; return response; } },
    });
    assert.equal(await route.GET(), response);
    assert.equal(reads, 1);
  }
});

test('IP setup admits its protected branding read while keeping the general bridge restricted', async () => {
  let completionReads = 0;
  const middleware = load('src/middleware.ts', {
    'next/server': { NextResponse },
    jose: { jwtVerify: async (token: string) => {
      if (token !== 'setup-owner') throw Error('Invalid session');
      return { payload: { isAdmin: true, authMethod: 'setup' } };
    } },
    '@/lib/auth/mode': { getAuthModeForHost: () => 'pam' },
    '@/lib/settings-public-path': { isSettingsPath: () => false },
  }, {
    URL, TextEncoder, AbortController, setTimeout, clearTimeout, console,
    process: { env: { JWT_SECRET: 'test-only-secret-with-at-least-32-characters' } },
    fetch: async (input: string) => {
      if (input.endsWith('/api/telemetry/record')) return new Response(null, { status: 204 });
      if (input.endsWith('/api/setup/config')) {
        completionReads++;
        return Response.json({ setup_completed: false });
      }
      throw Error(`Unexpected fetch: ${input}`);
    },
  }).middleware;
  const request = (route: string, authenticated = true) => new NextRequest(`https://192.0.2.10${route}`, {
    headers: { host: '192.0.2.10', ...(authenticated ? { cookie: 'ye-session=setup-owner' } : {}) },
  });
  const allowed = await middleware(request('/api/setup/branding'));
  assert.equal(allowed.headers.get('x-middleware-next'), '1');
  assert.equal(allowed.headers.has('location'), false);
  assert.equal((await middleware(request('/api/setup/branding', false))).status, 401);
  for (const route of ['/api/ui/branding', '/api/ui/branding/other', '/api/users']) {
    const blocked = await middleware(request(route));
    assert.equal(blocked.headers.get('x-middleware-next'), null, route);
  }
  assert.equal(completionReads, 1);
  const configuredHost = new NextRequest('https://example.test/api/ui/branding', {
    headers: { host: 'example.test', cookie: 'ye-session=setup-owner' },
  });
  assert.equal((await middleware(configuredHost)).status, 403);
});
