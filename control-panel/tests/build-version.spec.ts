import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const tree = 'b39fe307'.padEnd(40, '0');
const scripts = [join(root, 'scripts/write-version.mjs'), join(root, '../ui/scripts/write-version.mjs')];
const run = (script: string, args: string[], env: Record<string, string | undefined>) => {
  const environment: Record<string, string | undefined> = { ...process.env, YOUEYE_VERSION: undefined, YOUEYE_SOURCE_TREE: tree, ...env };
  if (environment.YOUEYE_VERSION === undefined) delete environment.YOUEYE_VERSION;
  for (const name of ['YOUEYE_LINE', 'YOUEYE_SOURCE_TREE'] as const) if (env[name] === undefined && name in env) delete environment[name];
  return spawnSync(process.execPath, [script, ...args], { env: environment, encoding: 'utf8' });
};

for (const script of scripts) {
  test(`${script.includes('/ui/') ? 'the UI' : 'the Control Panel'} build writes version.json from YOUEYE_LINE and YOUEYE_SOURCE_TREE only`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'youeye-version-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(join(dir, 'app', 'server.js'), '');
      assert.notEqual(run(script, ['--check'], { YOUEYE_LINE: undefined }).status, 0, 'an unset line fails the build');
      // Nothing built names a build (Plan 12): build and release names are refused, only the line is written.
      for (const name of ['0.6.1-dev.3', '0.6.1-dev', '0.6.1-rc.3', '0.6.1-alpha.1', '0.6.1-beta.1', '0.6', '01.6.1']) {
        assert.notEqual(run(script, ['--check'], { YOUEYE_LINE: name }).status, 0, name);
      }
      assert.equal(run(script, ['--check'], { YOUEYE_LINE: '0.6.1' }).status, 0);
      // The source tree is required too: the exact 40-character git tree.
      for (const value of [undefined, '', 'b39fe307', tree.toUpperCase()]) {
        assert.notEqual(run(script, ['--check'], { YOUEYE_LINE: '0.6.1', YOUEYE_SOURCE_TREE: value }).status, 0, String(value));
      }
      // A build name in YOUEYE_VERSION (still set by the build contract) never reaches the file.
      assert.equal(run(script, [dir], { YOUEYE_LINE: '0.6.1', YOUEYE_VERSION: '0.6.1-dev.3' }).status, 0);
      const written = readFileSync(join(dir, 'app', 'version.json'), 'utf8');
      assert.deepEqual(JSON.parse(written), { version: '0.6.1', source_tree: tree });
      assert.doesNotMatch(written, /-dev\./);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('package.json carries a fixed placeholder version', () => {
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.0');
});
