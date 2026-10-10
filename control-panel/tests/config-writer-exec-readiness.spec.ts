import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function fixture(failure?: 'readiness' | 'permissions' | 'readback') {
  const calls: string[] = [];
  const source = readFileSync(path.join(import.meta.dirname, '../src/lib/market/config-writer.ts'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name === 'path') return path;
    if (name === './variables') return { resolveVariables: (value: string) => value };
    if (name === '../incus/snapshot') return { waitForContainerExec: async (name: string) => {
      calls.push(`ready:${name}`);
      if (failure === 'readiness') throw new Error('Container did not become exec-ready');
    } };
    if (name === '../incus/server') return { execCommand: async (_name: string, command: string[]) => {
      calls.push(command.join(' '));
      if (failure === 'permissions' && command[0] === 'chmod') return { exitCode: 1, stdout: '' };
      return { exitCode: 0, stdout: command[0] === 'stat'
        ? failure === 'readback' ? '777' : command.at(-1) === '/opt/fixture' ? '700' : '600' : '' };
    } };
    throw new Error(`Unexpected import ${name}`);
  }, exports);
  return { calls, enforce: () => exports.enforceConfigFilePermissions('app-fixture', {
    container: 'main', path: '/opt/fixture/config', permission: '0o600', directoryPermission: '0o700', template: 'private',
  }, {}) };
}

test('post-start permissions wait for exec transport and verify directory and file modes', async () => {
  const f = fixture(); await f.enforce();
  assert.deepEqual(f.calls, ['ready:app-fixture', 'chmod 0700 /opt/fixture', 'stat -c %a /opt/fixture',
    'chmod 0600 /opt/fixture/config', 'stat -c %a /opt/fixture/config']);
});
test('an unready transport applies no permission changes', async () => {
  const f = fixture('readiness'); await assert.rejects(f.enforce(), /exec-ready/);
  assert.deepEqual(f.calls, ['ready:app-fixture']);
});
test('permission rejection after readiness remains a failure', async () => {
  const f = fixture('permissions'); await assert.rejects(f.enforce(), /could not be applied/);
  assert.deepEqual(f.calls, ['ready:app-fixture', 'chmod 0700 /opt/fixture']);
});
test('a widened mode after chmod remains a failure', async () => {
  const f = fixture('readback'); await assert.rejects(f.enforce(), /did not read back exactly/);
  assert.deepEqual(f.calls, ['ready:app-fixture', 'chmod 0700 /opt/fixture', 'stat -c %a /opt/fixture']);
});
