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

test('the launcher gives every request its TCP peer as x-youeye-peer, replacing a forged one, and changes nothing else (YE-136)', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'youeye-node-runtime-peer-'));
  let child;
  try {
    writeFileSync(join(root, 'server.js'), `const http=require('node:http'); const fs=require('node:fs');
const server=http.createServer({keepAliveTimeout:4321},(q,r)=>r.end(JSON.stringify({peer:q.headers['x-youeye-peer'],forwarded:q.headers['x-forwarded-for'],port:q.socket.remotePort,raw:q.rawHeaders.filter((h,i)=>i%2===0).map(h=>h.toLowerCase())})));
server.on('upgrade',(q,socket)=>{socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: test\\r\\nConnection: Upgrade\\r\\nX-Upgrade-Peer: '+(q.headers['x-youeye-peer']||'none')+'\\r\\n\\r\\n');});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,keepAliveTimeout:server.keepAliveTimeout,flag:process.env.YOUEYE_PEER_HEADER})));
process.on('SIGTERM',()=>{fs.writeFileSync(process.env.TEST_TERMINATION_FILE,'terminated');server.close(()=>process.exit(0));server.closeIdleConnections();});\n`);
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs","version":"1.0.0"}\n');
    const packaged = spawnSync(process.execPath, [packager, root], { encoding: 'utf8' });
    assert.equal(packaged.status, 0, packaged.stderr);
    const termination = join(root, 'termination.txt');
    child = spawn(process.execPath, [join(root, 'server.js')], {
      env: { ...process.env, TEST_TERMINATION_FILE: termination }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => JSON.parse(data.toString())),
      once(child, 'exit').then(([code]) => { throw new Error(`Launcher exited before readiness: ${code}`); }),
    ]);
    assert.equal(ready.keepAliveTimeout, 4321, 'server options pass through');
    assert.equal(ready.flag, '1', 'the server knows the peer header is the launcher\'s');
    const http = await import('node:http');
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (headers) => new Promise((resolveGet, reject) => {
      http.get({ host: '127.0.0.1', port: ready.port, agent, headers }, (response) => {
        let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolveGet(JSON.parse(body)));
      }).on('error', reject);
    });
    const first = await get({});
    const forged = await get({ 'X-YouEye-Peer': '10.45.18.13', 'X-Forwarded-For': '6.6.6.6' });
    for (const answer of [first, forged]) assert.equal(answer.peer, '127.0.0.1');
    assert.equal(forged.forwarded, '6.6.6.6', 'other headers are left alone');
    assert.equal(forged.port, first.port, 'keep-alive: both requests on one connection');
    assert.ok(!first.raw.includes('x-youeye-peer'), 'the raw headers are what the client sent');
    agent.destroy();

    const upgraded = await new Promise((resolveUpgrade, reject) => {
      http.request({ host: '127.0.0.1', port: ready.port, headers: { Connection: 'Upgrade', Upgrade: 'test' } })
        .on('upgrade', (response, socket) => { socket.destroy(); resolveUpgrade(response); })
        .on('error', reject).end();
    });
    assert.equal(upgraded.statusCode, 101, 'upgrades (websockets) still reach the server');
    assert.equal(upgraded.headers['x-upgrade-peer'], 'none', 'the upgrade path is untouched');

    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    assert.equal((await stopped)[0], 0, 'shutdown as before');
    assert.equal(readFileSync(termination, 'utf8'), 'terminated');
  } finally { child?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
