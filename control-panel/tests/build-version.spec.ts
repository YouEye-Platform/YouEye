import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const tree = 'b39fe307'.padEnd(40, '0');
const run = (args: string[], env: Record<string, string | undefined>) => {
  const environment = { ...process.env, YOUEYE_SOURCE_TREE: tree, ...env };
  for (const name of ['YOUEYE_VERSION', 'YOUEYE_SOURCE_TREE'] as const) if (env[name] === undefined && name in env) delete environment[name];
  return spawnSync(process.execPath, [join(root, 'scripts/write-version.mjs'), ...args], { env: environment, encoding: 'utf8' });
};

test('the build writes version.json next to server.js from YOUEYE_VERSION and YOUEYE_SOURCE_TREE only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'youeye-version-'));
  try {
    mkdirSync(join(dir, 'control-panel'));
    writeFileSync(join(dir, 'control-panel', 'server.js'), '');
    assert.notEqual(run(['--check'], { YOUEYE_VERSION: undefined }).status, 0, 'an unset version fails the build');
    assert.notEqual(run(['--check'], { YOUEYE_VERSION: '0.6.1-dev' }).status, 0);
    // Release names are never build versions.
    for (const name of ['0.6.1-rc.3', '0.6.1-alpha.1', '0.6.1-beta.1', '0.6.1']) {
      assert.notEqual(run(['--check'], { YOUEYE_VERSION: name }).status, 0, name);
    }
    assert.equal(run(['--check'], { YOUEYE_VERSION: '0.6.1-dev.3' }).status, 0);
    // The source tree is required too: the exact 40-character git tree.
    for (const value of [undefined, '', 'b39fe307', tree.toUpperCase()]) {
      assert.notEqual(run(['--check'], { YOUEYE_VERSION: '0.6.1-dev.3', YOUEYE_SOURCE_TREE: value }).status, 0, String(value));
    }
    assert.equal(run([dir], { YOUEYE_VERSION: '0.6.1-dev.3' }).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'control-panel', 'version.json'), 'utf8')), { version: '0.6.1-dev.3', source_tree: tree });
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
