import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const run = (args: string[], env: Record<string, string | undefined>) => {
  const environment = { ...process.env, ...env };
  if (env.YOUEYE_VERSION === undefined) delete environment.YOUEYE_VERSION;
  return spawnSync(process.execPath, [join(root, 'scripts/write-version.mjs'), ...args], { env: environment, encoding: 'utf8' });
};

test('the build writes version.json next to server.js from YOUEYE_VERSION only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'youeye-version-'));
  try {
    mkdirSync(join(dir, 'control-panel'));
    writeFileSync(join(dir, 'control-panel', 'server.js'), '');
    assert.notEqual(run(['--check'], { YOUEYE_VERSION: undefined }).status, 0, 'an unset version fails the build');
    assert.notEqual(run(['--check'], { YOUEYE_VERSION: '0.6.1-dev' }).status, 0);
    assert.equal(run(['--check'], { YOUEYE_VERSION: '0.6.1-rc.3' }).status, 0);
    assert.equal(run([dir], { YOUEYE_VERSION: '0.6.1-rc.3' }).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'control-panel', 'version.json'), 'utf8')), { version: '0.6.1-rc.3' });
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
