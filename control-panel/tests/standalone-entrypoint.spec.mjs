import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const helper = resolve(import.meta.dirname, '../../.youeye/build/lib.sh');
function fixture(paths, run) {
  const root = mkdtempSync(join(tmpdir(), 'youeye-standalone-'));
  try {
    for (const path of paths) { const p = join(root,path); mkdirSync(dirname(p), {recursive:true}); writeFileSync(p, '// fixture'); }
    run(root);
  } finally { rmSync(root,{recursive:true,force:true}); }
}
function locate(root) { return spawnSync('bash',['-c','source "$1"; youeye_find_standalone_root "$2"','standalone-test',helper,root],{encoding:'utf8'}); }
test('nested app excludes dependency and static server.js files', () => fixture([
  'control-panel/server.js', 'node_modules/next/dist/server/server.js',
  'node_modules/react-dom/server.js', 'control-panel/node_modules/dependency/server.js',
  'control-panel/.next/server/server.js', 'control-panel/public/server.js',
], root => { const r=locate(root); assert.equal(r.status,0,r.stderr); assert.equal(r.stdout.trim(),join(root,'control-panel')); }));
test('root standalone remains supported', () => fixture(['server.js','node_modules/next/server.js'],root => {const r=locate(root);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),root);}));
test('two actual applications remain ambiguous', () => fixture(['cp/server.js','ui/server.js'],root => {const r=locate(root);assert.notEqual(r.status,0);assert.match(r.stderr,/found 2/);}));
test('dependency entrypoints alone are not an application', () => fixture(['node_modules/next/dist/server/server.js'],root => {const r=locate(root);assert.notEqual(r.status,0);assert.match(r.stderr,/found 0/);}));
