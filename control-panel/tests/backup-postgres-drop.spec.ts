import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);

// A model of PostgreSQL's drop race: a client (a connection pool) reconnects as soon as its session is
// terminated. A drop after a separate terminate then finds a session and fails; DROP ... WITH (FORCE)
// takes the database lock first, so the reconnect waits and the drop succeeds.
type Exec = (text: string) => { exitCode: number; stdout: string; stderr: string } | undefined;
function restoreModule(override?: Exec) {
  const sql: string[] = [];
  let sessions = 1;
  const execCommand = async (_container: string, command: string[]) => {
    const text = command.join(' ');
    sql.push(text);
    const answer = override?.(text);
    if (answer) return answer;
    if (text.includes('pg_terminate_backend')) { sessions = 0; sessions = 1; return { exitCode: 0, stdout: '', stderr: '' }; }
    if (text.includes('DROP DATABASE') && !text.includes('WITH (FORCE)') && sessions > 0) {
      return { exitCode: 1, stdout: '', stderr: 'ERROR:  database "pointer" is being accessed by other users\nDETAIL:  There is 1 other session using the database.\n' };
    }
    if (text.includes('CREATE DATABASE')) return { exitCode: 1, stdout: '', stderr: 'ERROR:  permission denied to create database\n' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const exports: Record<string, any> = {};
  const file = path.join(process.cwd(), 'src/lib/backup/postgres.ts');
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, require(name: string) {
    if (name === '@/lib/incus/server') return { execCommand, incusUploadFile: async () => undefined };
    if (name === './postgres-owner-policy') return { restoredAppOwnerSessionPolicy: () => '' };
    if (name.startsWith('node:')) return require(name);
    return {};
  } });
  return { exports, sql };
}

test('a platform restore drops its database even when a client reconnects at once', async () => {
  const { exports, sql } = restoreModule();
  // The drop must pass; the (stubbed) create then fails, and its error keeps PostgreSQL's reason.
  await assert.rejects(exports.replacePlatformDatabase('pointer', Buffer.from('')),
    /^Error: Create PostgreSQL database pointer failed: ERROR: {2}permission denied to create database$/);
  assert.ok(sql.some(text => text.includes('DROP DATABASE IF EXISTS "pointer" WITH (FORCE)')));
  assert.ok(!sql.some(text => text.includes('pg_terminate_backend')));
});

test('app database restores and cleanup drop with FORCE', async () => {
  for (const run of [
    (m: any) => m.replacePlatformAppDatabase({ database: 'notes', user: 'notes', password: 'x', dump: Buffer.from('') }),
    (m: any) => m.restoreOwnPostgresDatabase({ container: 'app-immich-db', database: 'immich', user: 'immich', dump: Buffer.from('') }),
    (m: any) => m.dropPlatformAppDatabase({ database: 'notes', user: 'notes' }),
  ]) {
    const { exports, sql } = restoreModule();
    await run(exports).catch(() => undefined);
    assert.ok(sql.some(text => /DROP DATABASE IF EXISTS "(notes|immich)" WITH \(FORCE\)/.test(text)), sql.join('\n'));
    assert.ok(!sql.some(text => text.includes('pg_terminate_backend')));
  }
});

test('other app database drops use FORCE instead of a separate terminate', () => {
  for (const file of ['market/uninstaller.ts', 'market/reconciler.ts', 'market/orphan-detector.ts', 'market/engine.ts']) {
    const source = readFileSync(path.join(process.cwd(), 'src/lib', file), 'utf8');
    assert.doesNotMatch(source, /pg_terminate_backend/, file);
    assert.match(source, /DROP DATABASE IF EXISTS [^`]*WITH \(FORCE\)/, file);
  }
});

test('a failed restore keeps PostgreSQL\'s ERROR line and never the rows its DETAIL and CONTEXT quote', async () => {
  const { exports } = restoreModule(text => {
    if (text.includes('CREATE DATABASE')) return { exitCode: 0, stdout: '', stderr: '' };
    if (text.includes('--file /tmp/youeye-restore-')) return { exitCode: 3, stdout: '', stderr: [
      'SET', 'psql:/tmp/youeye-restore-1.sql:42: ERROR:  duplicate key value violates unique constraint "users_email_key"',
      'DETAIL:  Key (email)=(alice@example.com) already exists.',
      'CONTEXT:  COPY users, line 3: "3\talice@example.com\tAlice Secret"',
      'HINT:  something with bob@example.com',
    ].join('\n') };
    return undefined;
  });
  const error = await exports.replacePlatformDatabase('youeye_ui', Buffer.from('')).catch((e: Error) => e);
  assert.equal(typeof error?.message, 'string', 'the restore fails');
  assert.match(error.message, /^PostgreSQL restore for youeye_ui failed: psql:\S+:42: ERROR: {2}duplicate key value violates unique constraint "users_email_key"$/);
  assert.doesNotMatch(error.message, /alice|bob|Secret|DETAIL|CONTEXT/);
  assert.equal(exports.postgresFailureReason(`FATAL:  ${'x'.repeat(900)}\nDETAIL:  Key (a)=(b)`).length, 301, 'bounded');
  assert.equal(exports.postgresFailureReason('pg_dump: error: query failed: ERROR:  permission denied\nDETAIL:  row'), 'pg_dump: error: query failed: ERROR:  permission denied');
  assert.equal(exports.postgresFailureReason('DETAIL:  Key (note)=(see ERROR: here)\n'), '');
});

test('an app restore never replaces or drops a platform database or role', async () => {
  for (const options of [
    { database: 'youeye', user: 'notes' }, { database: 'youeye_ui', user: 'notes' }, { database: 'pointer', user: 'notes' },
    { database: 'postgres', user: 'notes' }, { database: 'template1', user: 'notes' },
    { database: 'notes', user: 'youeye' }, { database: 'notes', user: 'postgres' },
  ]) {
    const replace = restoreModule();
    await assert.rejects(replace.exports.replacePlatformAppDatabase({ ...options, password: 'x', dump: Buffer.from('') }),
      /Refusing to replace a platform database/, JSON.stringify(options));
    assert.deepEqual(replace.sql, [], 'nothing ran');
    const drop = restoreModule();
    await assert.rejects(drop.exports.dropPlatformAppDatabase(options), /Refusing to drop a platform database/);
    assert.deepEqual(drop.sql, []);
  }
});
