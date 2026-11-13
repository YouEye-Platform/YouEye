import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// The credentials route returns apps' generated admin passwords: only administrators may read them.
function fixture(administrator: boolean) {
  const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(),
    'src/app/api/market/credentials/route.ts'), 'utf8');
  const exports: { GET?: (request: { nextUrl: URL }) => Promise<Response> } = {};
  const reads: string[] = [];
  const mocks: Record<string, unknown> = {
    'next/server': { NextResponse: { json: Response.json } },
    '@/lib/auth/rbac': { requireAdmin: async () => administrator
      ? { session: { isAdmin: true } } : { error: Response.json({ error: 'Denied' }, { status: 403 }) } },
    '@/lib/market/metadata': { readInstallMetadata: async (appId: string) => appId === 'demo'
      ? { credentials: [{ label: 'Admin', username: 'admin', passwordSecret: 'admin_password' }] } : null },
    '@/lib/infrastructure/secrets': {
      isAppSecretName: (name: string) => /^[a-z0-9_]+$/.test(name),
      readAppSecret: async (appId: string, name: string) => { reads.push(`${appId}/${name}`); return 'generated-fixture'; },
    },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Response, URL, require(name: string) {
    if (name in mocks) return mocks[name];
    throw new Error(`unexpected import ${name}`);
  } });
  return { GET: exports.GET!, reads };
}

const request = (query: string) => ({ nextUrl: new URL(`http://cp.test/api/market/credentials${query}`) });

test('a standard user cannot read app credentials, and no secret is read', async () => {
  const { GET, reads } = fixture(false);
  assert.equal((await GET(request('?app=demo'))).status, 403);
  assert.deepEqual(reads, []);
});

test('an administrator gets the credential list for ?app=', async () => {
  const { GET } = fixture(true);
  const response = await GET(request('?app=demo'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    credentials: [{ label: 'Admin', username: 'admin', password: 'generated-fixture' }],
  });
  assert.equal((await GET(request(''))).status, 400);
  assert.equal((await GET(request('?app=missing'))).status, 404);
});
