import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createPlatformDatabase } from '../src/lib/postgres/platform-transport';

const url = process.env.YOUEYE_PLATFORM_TEST_DB_URL;
test('pooled platform SQL preserves text, transactions and recovery without replay', { skip: !url }, async () => {
  const target = new URL(url!);
  const name = target.pathname.slice(1);
  assert.match(name, /^youeye_platform_test_[a-z0-9_]+$/);
  const database = createPlatformDatabase(async () => ({ host: target.hostname, port: target.port || '5432',
    user: decodeURIComponent(target.username), password: decodeURIComponent(target.password), database: name }));
  try {
    await database.command('CREATE TABLE IF NOT EXISTS pool_test (id integer PRIMARY KEY, value text)');
    await database.command('TRUNCATE pool_test');
    assert.equal(await database.command("SELECT '[{\"value\":\"quote''\\\\line\"}]'::text"), '[{"value":"quote\'\\\\line"}]');
    assert.equal(await database.command('SELECT 9223372036854775807::bigint'), '9223372036854775807');
    const pids = await Promise.all(Array.from({ length: 12 }, () => database.command('SELECT pg_backend_pid()')));
    assert.ok(new Set(pids).size <= 1, 'concurrent callers must reuse one connection per process');
    await database.command("BEGIN; INSERT INTO pool_test VALUES (1, 'kept'); COMMIT;");
    await assert.rejects(database.command("BEGIN; INSERT INTO pool_test VALUES (2, 'rolled back'); SELECT 1/0; COMMIT"), /22012/);
    assert.equal(await database.command('SELECT count(*) FROM pool_test'), '1');
    assert.equal(await database.command("SELECT value FROM pool_test WHERE id=1"), 'kept');
    await assert.rejects(database.command('SELECT pg_terminate_backend(pg_backend_pid())'), /Platform database command failed/);
    assert.equal(await database.command('SELECT count(*) FROM pool_test'), '1', 'transport reconnect must not repeat prior writes');
    const source = ts.transpileModule(readFileSync('src/lib/health/issue-store.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const loadRegistry = () => {
      const exports: any = {};
      runInNewContext(source, { exports, require(id: string) {
        if (id === '@/lib/postgres/platform') return { platformCommand: database.command };
        throw new Error(`Health persistence must use the admitted database transport: ${id}`);
      } });
      return exports;
    };
    await database.command('DROP TABLE IF EXISTS health_registry_state');
    const registry = loadRegistry();
    assert.equal(await registry.readHealthRegistry(), null);
    const value = { issues: { "quoted'key": { body: "Literal \\ and ' and 日本語", count: 2 } }, debounce: {} };
    const backend = await database.command('SELECT pg_backend_pid()');
    await registry.writeHealthRegistry(value);
    assert.equal(JSON.stringify(await loadRegistry().readHealthRegistry()), JSON.stringify(value));
    assert.equal(await database.command('SELECT pg_backend_pid()'), backend, 'registry reads and writes reuse the admitted connection');
  } finally {
    await database.close();
  }
});
