import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const packager = resolve('scripts/bundle-node-runtime.mjs');
test('signed Node handoff preserves entrypoint, exit and termination behavior', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'youeye-node-runtime-'));
  let child;
  try {
    const source = `const http=require('node:http'); const fs=require('node:fs');
const server=http.createServer((q,r)=>r.end('ok'));
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({version:process.version,pid:process.pid})));
process.on('SIGTERM',()=>{fs.writeFileSync(process.env.TEST_TERMINATION_FILE,'terminated');server.close(()=>process.exit(0));});\n`;
    writeFileSync(join(root, 'server.js'), source);
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs","version":"1.0.0"}\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      const packaged = spawnSync(process.execPath, [packager, root], { encoding: 'utf8' });
      assert.equal(packaged.status, 0, packaged.stderr);
      assert.equal(readFileSync(join(root, 'next-server.cjs'), 'utf8'), source);
    }
    const termination = join(root, 'termination.txt');
    child = spawn(process.execPath, [join(root, 'server.js')], {
      env: { ...process.env, TEST_TERMINATION_FILE: termination }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => JSON.parse(data.toString())),
      once(child, 'exit').then(([code]) => { throw new Error(`Launcher exited before readiness: ${code}`); }),
    ]);
    assert.equal(ready.version, 'v24.22.0'); assert.notEqual(ready.pid, child.pid);
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    assert.equal((await stopped)[0], 0);
    assert.equal(readFileSync(termination, 'utf8'), 'terminated');
    assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
    rmSync(join(root, '.youeye-runtime/node'));
    const missing = spawnSync(process.execPath, [join(root, 'server.js')], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
  } finally { child?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
