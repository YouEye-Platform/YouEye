import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('health route bundles share cold/warm observations and recover after expiry', async () => {
  let now = 1_000_000;
  let reads = 0;
  let unavailable = false;
  const shared = {};
  const source = ts.transpileModule(readFileSync('src/lib/health/service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const load = () => {
    const exports: any = {};
    runInNewContext(source, { exports, globalThis: shared, Buffer, setTimeout,
      Date: class extends Date { static now() { return now; } },
      require(id: string) {
        if (id === '@/lib/incus/server') return {
          async getInstanceState() {
            reads++;
            if (unavailable) throw new Error('provider disconnected');
            return { metadata: { status: 'Running', cpu: { usage: now * 10 }, memory: { usage: 1024 } } };
          },
          async incusDownloadFile(_container: string, path: string) {
            return Buffer.from(path === '/proc/uptime' ? '600 0' : 'CORE_VERSION=v6.0');
          },
          async execShell(_container: string, command: string) {
            return { exitCode: 0, stdout: command.includes('pihole') ? 'FTL is listening'
              : command.includes('readyz') ? '{"status":"ready"}' : '200' };
          },
        };
        if (id === '@/lib/spine/client') return { spineClient: {
          async health() { return { status: 'ok' }; }, async version() { return { version: 'test' }; },
        } };
        if (id === '@/lib/postgres/platform') return { async platformCommand() { return '17'; } };
        throw new Error(id);
      },
    });
    return exports;
  };
  const route = load(), monitor = load();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 ? route : monitor).getAllServicesHealth()));
  assert.equal(reads, 4, 'one collection across concurrent callers and separately loaded bundles');
  assert.ok(results.every(value => value === results[0]));
  await monitor.getAllServicesHealth();
  assert.equal(reads, 4);
  now += 15_001; unavailable = true;
  const failed = await route.getAllServicesHealth();
  assert.equal(reads, 8);
  assert.equal(failed.find((service: any) => service.slug === 'postgres').status, 'unknown');
  now += 15_001; unavailable = false;
  const recovered = await monitor.getAllServicesHealth();
  assert.equal(reads, 12);
  assert.equal(recovered.find((service: any) => service.slug === 'postgres').status, 'running');
});
