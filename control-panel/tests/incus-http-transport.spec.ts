import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIncusTransport } from '../src/lib/incus/http-transport';

test('Unix requests reuse connections, parse chunked UTF-8, and return Incus errors without retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'incus-http-'));
  let connections = 0; let writes = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === 'PATCH') { writes++; req.socket.destroy(); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end('{"type":"error","error_code":404}'); return; }
    const data = Buffer.from('{"metadata":"猫"}');
    res.write(data.subarray(0, 14)); res.end(data.subarray(14));
  });
  server.on('connection', () => connections++);
  const socketPath = path.join(root, 'incus.sock');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const transport = createIncusTransport(() => ({ tls: false, socketPath }));
  try {
    for (let i = 0; i < 5; i++) assert.equal((await transport.request<{ metadata: string }>('GET', '/')).metadata, '猫');
    assert.equal(connections, 1);
    await Promise.all(Array.from({ length: 16 }, () => transport.request('GET', '/burst')));
    assert.equal(connections, 16);
    await new Promise(resolve => setTimeout(resolve, 50));
    await Promise.all(Array.from({ length: 16 }, () => transport.request('GET', '/burst')));
    assert.equal(connections, 16, 'a full bounded audit burst should reuse its idle connections');
    assert.equal((await transport.request<{ error_code: number }>('GET', '/missing')).error_code, 404);
    await assert.rejects(transport.request('PATCH', '/', { devices: {} }), /Socket error/);
    assert.equal(writes, 1, 'ambiguous write must never be replayed');
    assert.equal((await transport.request<{ metadata: string }>('GET', '/')).metadata, '猫');
  } finally { transport.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});

test('an idle reused GET reset is retried once, while fresh failures and writes are not replayed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'incus-reset-'));
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    req.resume();
    const key = `${req.method} ${req.url}`;
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    if (req.url === '/reset' && count === 1 || req.url === '/always-reset' || req.method === 'PATCH') {
      req.socket.destroy(); return;
    }
    res.end('{"metadata":"ok"}');
  });
  const socketPath = path.join(root, 'incus.sock');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const transport = createIncusTransport(() => ({ tls: false, socketPath }));
  try {
    await transport.request('GET', '/warm');
    assert.equal((await transport.request<{ metadata: string }>('GET', '/reset')).metadata, 'ok');
    assert.equal(counts.get('GET /reset'), 2);
    await assert.rejects(transport.request('GET', '/always-reset'), /Socket error/);
    assert.equal(counts.get('GET /always-reset'), 2, 'retry is bounded at one even if the second read fails');
    await assert.rejects(transport.request('GET', '/always-reset'), /Socket error/);
    assert.equal(counts.get('GET /always-reset'), 3, 'a fresh connection failure is not replayed');
    await transport.request('GET', '/warm');
    await assert.rejects(transport.request('PATCH', '/write', {}), /Socket error/);
    assert.equal(counts.get('PATCH /write'), 1);
    await transport.request('GET', '/warm');
    await assert.rejects(transport.request('GET', '/always-reset', { unusual: 'body' }), /Socket error/);
    assert.equal(counts.get('GET /always-reset'), 4, 'GET with a body is not eligible for replay');
  } finally { transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});

test('reused GET retry retains the original absolute deadline and never retries a partial response', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'incus-reset-deadline-'));
  let delayedReads = 0; let partialReads = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/delayed') {
      if (++delayedReads === 1) setTimeout(() => req.socket.destroy(), 60);
      else setTimeout(() => res.end('{"metadata":"late"}'), 80);
      return;
    }
    if (req.url === '/partial') {
      partialReads++; res.write('{"metadata":'); setTimeout(() => req.socket.destroy(), 5); return;
    }
    res.end('{"metadata":"ok"}');
  });
  const socketPath = path.join(root, 'incus.sock');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const transport = createIncusTransport(() => ({ tls: false, socketPath }));
  try {
    await transport.request('GET', '/warm');
    await assert.rejects(transport.request('GET', '/delayed', undefined, { deadlineMs: 110 }), /absolute timeout/);
    assert.equal(delayedReads, 2);
    await transport.request('GET', '/warm');
    await assert.rejects(transport.request('GET', '/partial'), /response interrupted/);
    assert.equal(partialReads, 1);
  } finally { transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});

test('HTTPS requests reuse TLS connections and honor inactivity and explicit absolute deadlines', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'incus-tls-'));
  const key = path.join(root, 'key.pem'); const cert = path.join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const credentials = { key: await readFile(key), cert: await readFile(cert) };
  let connections = 0; let resetReads = 0;
  const server = createHttpsServer({ ...credentials, ca: credentials.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    req.resume();
    if (req.url === '/reset' && ++resetReads === 1) { req.socket.destroy(); return; }
    if (req.url === '/burst') { setTimeout(() => res.end('{"metadata":"ok"}'), 30); return; }
    if (req.url === '/stall') return;
    if (req.url === '/stream') {
      res.write('{"metadata":"');
      let count = 0;
      const timer = setInterval(() => { if (++count === 8) { clearInterval(timer); res.end('"}'); } else res.write('a'); }, 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end('{"metadata":"ok"}');
  });
  server.on('secureConnection', () => connections++);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const transport = createIncusTransport(() => ({ tls: true, host: '127.0.0.1', port: address.port, ...credentials }));
  try {
    for (let i = 0; i < 4; i++) await transport.request('GET', '/');
    assert.equal(connections, 1);
    await Promise.all(Array.from({ length: 16 }, () => transport.request('GET', '/burst')));
    assert.equal(connections, 16);
    await new Promise(resolve => setTimeout(resolve, 50));
    await Promise.all(Array.from({ length: 16 }, () => transport.request('GET', '/burst')));
    assert.equal(connections, 16, 'a full bounded audit burst should reuse its idle connections');
    assert.equal((await transport.request<{ metadata: string }>('GET', '/reset')).metadata, 'ok');
    assert.equal(resetReads, 2, 'TLS reused-connection reads have the same bounded recovery');
    assert.equal((await transport.request<{ metadata: string }>('GET', '/stream', undefined, { timeout: 100 })).metadata, 'aaaaaaa');
    await assert.rejects(transport.request('GET', '/stream', undefined, { timeout: 100, deadlineMs: 60 }), /absolute timeout/);
    await assert.rejects(transport.request('GET', '/stall', undefined, { timeout: 100 }), /timeout/);
    assert.equal((await transport.request<{ metadata: string }>('GET', '/')).metadata, 'ok');
  } finally { transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); }
});
