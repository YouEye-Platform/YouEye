import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  const registered = new Set(Array.from({ length: 17 }, (_, i) => `example${i}`));
  const sql: string[] = []; const created: string[] = []; const projected: string[] = [];
  let batchBroken = false;
  const mocks: Record<string, unknown> = {
    'fs/promises': { readFile: async () => 'fixture-token' },
    '@/lib/incus/container-ip': { getContainerIP: async () => '192.0.2.10' },
    '../bridges/manager': { pushConnectionsToUI: async (id: string) => { if (!registered.has(id)) throw Error('UI app absent'); projected.push(id); } },
    '@/lib/incus/server': { execCommand: async (_container: string, argv: string[]) => {
      const query = argv.at(-1)!; sql.push(query);
      if (query.includes('json_agg')) return { exitCode: 0, stdout: batchBroken ? '{}' : JSON.stringify([...registered].map(id => ({ id, connections: null }))) };
      const id = query.match(/WHERE id = '([^']+)'/)![1];
      return { exitCode: 0, stdout: registered.has(id) ? '1' : '' };
    } },
  };
  const exports: Record<string, any> = {};
  const source = readFileSync('src/lib/market/reconciler.ts', 'utf8') + '\nexport { listUIRegistrations, reconcileUIRegistration };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, console, process: { env: {} },
    require: (name: string) => mocks[name] ?? {},
    fetch: async (_url: string, options: { body: string }) => { const id = JSON.parse(options.body).id; registered.add(id); created.push(id); return { ok: true }; },
  });
  return { ...exports, sql, created, projected, registered, breakBatch() { batchBroken = true; } } as any;
}

test('one database execution verifies 17 existing registrations without per-app shell/SQL', async () => {
  const f = fixture(); const observed = await f.listUIRegistrations();
  for (const appId of f.registered) assert.equal(await f.reconcileUIRegistration({ appId }, observed), false);
  assert.equal(f.sql.length, 1); assert.equal(f.projected.length, 17); assert.deepEqual(f.created, []);
});

test('a stale missing registration is read again before creation and verified afterward', async () => {
  const f = fixture(); const observed = await f.listUIRegistrations();
  f.registered.add('concurrent');
  assert.equal(await f.reconcileUIRegistration({ appId: 'concurrent' }, observed), false);
  assert.deepEqual(f.created, []);
  assert.equal(await f.reconcileUIRegistration({ appId: 'missing' }, observed), true);
  assert.deepEqual(f.created, ['missing']);
  assert.equal(f.sql.length, 4); // batch, concurrent recheck, missing pre/post checks
});

test('unknown batch data fails closed and per-app fallback still verifies registration', async () => {
  const f = fixture(); f.breakBatch();
  await assert.rejects(f.listUIRegistrations(), /Invalid/);
  assert.equal(await f.reconcileUIRegistration({ appId: 'example0' }, null), false);
  assert.equal(f.sql.length, 2); assert.deepEqual(f.created, []);
});

test('deletion after the batch is detected by the current projection and repaired next pass', async () => {
  const f = fixture(); const observed = await f.listUIRegistrations(); f.registered.delete('example0');
  await assert.rejects(f.reconcileUIRegistration({ appId: 'example0' }, observed), /absent/);
  assert.equal(await f.reconcileUIRegistration({ appId: 'example0' }, await f.listUIRegistrations()), true);
  assert.deepEqual(f.created, ['example0']);
});
