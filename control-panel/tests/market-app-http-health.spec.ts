import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function fixture(status: number, failConnection = false) {
  let now = 0;
  let probes = 0;
  class Clock extends Date { static now() { return now; } }
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(join(import.meta.dirname, '../src/lib/market/health.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', 'fetch', 'setTimeout', 'Date', source)(
    () => ({ getContainerIP: async () => '127.0.0.1' }), exports,
    async () => {
      probes++;
      if (failConnection) throw new Error('connection refused');
      return { status };
    },
    (resolve: () => void, delay: number) => { now += delay; resolve(); }, Clock,
  );
  return { probe: () => exports.waitForAppHealth('fixture', 8080, '/health', 10_000), count: () => probes };
}

for (const status of [200, 204, 301, 401, 403]) {
  test(`declared HTTP health accepts ${status}`, async () => {
    const f = fixture(status);
    assert.equal(await f.probe(), true);
    assert.equal(f.count(), 1);
  });
}
for (const status of [199, 400, 404, 405, 429, 500, 503]) {
  test(`declared HTTP health refuses ${status} rather than committing an unavailable endpoint`, async () => {
    const f = fixture(status);
    assert.equal(await f.probe(), false);
    assert.ok(f.count() > 1);
  });
}
test('connection failures cannot pass declared HTTP health', async () => {
  const f = fixture(200, true);
  assert.equal(await f.probe(), false);
  assert.ok(f.count() > 1);
});
