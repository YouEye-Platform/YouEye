import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(route: string, administrator = true) {
  const effects: Array<unknown> = [];
  const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(),
    'src/app/api/market', route, 'route.ts'), 'utf8');
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  const mocks: Record<string, unknown> = {
    'next/server': { NextResponse: { json: Response.json } },
    '@/lib/auth/rbac': { requireAdmin: async () => administrator
      ? { session: { isAdmin: true } } : { error: Response.json({ error: 'Denied' }, { status: 403 }) } },
    '@/lib/auth/session': { verifyCSRFToken: async (token: string) => token === 'valid-fixture' },
    '@/lib/admission/management': { admissionAdministrator: async () => '11111111-1111-4111-8111-111111111111' },
    '@/lib/health/issues': { assertNoCriticalIssues: async () => {} },
    '@/lib/market/uninstaller': { uninstallApp: async (...args: unknown[]) => {
      effects.push(args); return { success: true }; } },
    '@/lib/events/emitter': { emitEvent: () => {} },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Response, require(name: string) {
    if (name in mocks) return mocks[name];
    return new Proxy({}, { get: (_target, property) => {
      if (property === '__esModule') return true;
      return () => { effects.push([name, String(property)]); throw Error('Unexpected effect'); };
    } });
  } });
  return { effects, POST: exports.POST! };
}
function request(token?: string, body = '{}') {
  return new Request('https://control.example.test/api/market/fixture', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { 'X-CSRF-Token': token } : {}) }, body,
  });
}
for (const route of ['install', 'install-url', 'uninstall']) {
  for (const token of [undefined, 'invalid-fixture']) test(`${route} rejects absent/invalid CSRF before parsing or effects (${token ?? 'absent'})`, async () => {
    const f = fixture(route);
    assert.equal((await f.POST(request(token, '{malformed'))).status, 403);
    assert.deepEqual(f.effects, []);
  });
  test(`${route} rejects an ordinary user before effects`, async () => {
    const f = fixture(route, false);
    assert.equal((await f.POST(request('valid-fixture'))).status, 403);
    assert.deepEqual(f.effects, []);
  });
  test(`${route} accepts valid CSRF and continues ordinary request validation`, async () => {
    const f = fixture(route);
    assert.equal((await f.POST(request('valid-fixture'))).status, 400);
    assert.deepEqual(f.effects, []);
  });
}
test('authorized keep-data uninstall reaches the lifecycle exactly once', async () => {
  const f = fixture('uninstall');
  assert.equal((await f.POST(request('valid-fixture', JSON.stringify({ appId: 'fixture', keepData: true })))).status, 200);
  assert.equal(f.effects.length, 1);
  assert.equal((f.effects[0] as [string, {keepData: boolean}])[0], 'fixture');
  assert.equal((f.effects[0] as [string, {keepData: boolean}])[1].keepData, true);
});
