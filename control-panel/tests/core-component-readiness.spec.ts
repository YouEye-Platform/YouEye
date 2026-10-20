import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/app/api/appliance/core-component/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const status = { managed: true, state: 'pending' };
  let available = false;
  let native = true;
  let writes = 0;
  const commands: string[] = [];
  const api: { GET?: (request: unknown) => Promise<{ status: number; body: typeof status }> } = {};
  runInNewContext(code, { exports: api, require(id: string) {
    if (id === 'next/server') return { NextResponse: { json: (body: unknown, options?: { status?: number }) => ({ status: options?.status ?? 200, body }) } };
    if (id === '@/lib/auth') return { getSession: async () => ({ isAdmin: true, authMethod: native ? 'cli' : 'browser' }) };
    if (id === '@/lib/updates/core-schema') return { coreSchemaStatus: async () => status };
    if (id === '@/lib/identity/store') return {
      ensureIdentitySchema: async () => { writes++; },
      identityCommand: async (sql: string) => { commands.push(sql); if (!available) throw new Error('private Incus transport detail'); },
    };
    if (id.endsWith('shared/core-component-http')) return {};
    throw new Error(`Unexpected import: ${id}`);
  } });
  return { status, commands, get: (health = false) => api.GET!({ nextUrl: new URL(`http://fixture/api/appliance/core-component${health ? '?health=1' : ''}`) }),
    ready: () => { available = true; }, browser: () => { native = false; }, writes: () => writes };
}

test('native readiness waits for the real database transport without starting a schema attempt', async () => {
  const f = fixture();
  const response = await f.get();
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response).includes('private Incus'));
  f.ready();
  assert.equal((await f.get()).status, 200);
  assert.deepEqual(f.commands, ['BEGIN READ ONLY; SELECT 1; COMMIT', 'BEGIN READ ONLY; SELECT 1; COMMIT']);
  assert.equal(f.status.state, 'pending');
  assert.equal(f.writes(), 0);
});

test('uncertain and started schema outcomes remain visible without probing or replaying', async () => {
  for (const state of ['started', 'unknown']) {
    const f = fixture(); f.status.state = state;
    assert.equal((await f.get()).body.state, state);
    assert.equal(f.commands.length, 0);
    assert.equal(f.writes(), 0);
  }
});

test('browser authority cannot perform native readiness and health still requires completed schema', async () => {
  const f = fixture(); f.browser();
  assert.equal((await f.get()).status, 403);
  assert.equal(f.commands.length, 0);
  const health = fixture(); health.ready();
  assert.equal((await health.get(true)).status, 503);
  health.status.state = 'completed';
  assert.equal((await health.get(true)).status, 200);
  assert.match(health.commands.at(-1)!, /BEGIN READ ONLY; SELECT id FROM identity_users/);
  assert.equal(health.writes(), 0);
});
