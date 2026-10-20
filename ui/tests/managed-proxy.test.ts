import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpsRequest } from 'node:https';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { managedProxyTransport, requestManagedProxy } from '../../shared/managed-proxy';

const directory = mkdtempSync(join(tmpdir(), 'youeye-managed-proxy-'));
let server: ReturnType<typeof createServer>;
let ca: string;
let otherCA: string;
let port: number;
let observed: { host?: string; path?: string; method?: string; body?: string };
const descriptor = () => ({ schema: 'youeye.managed-proxy.v1', address: '10.1.2.3', hostname: 'backend.test', ca });
// The fixture binds loopback; production still validates and dials its CP-owned
// private address. TLS naming, CA validation and HTTP bytes remain real.
const fixtureRequest: typeof httpsRequest = ((options: object, callback: unknown) =>
  httpsRequest({ ...options, hostname: '127.0.0.1', port }, callback as never)) as typeof httpsRequest;

before(async () => {
  for (const name of ['backend', 'other']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${name}.test`, '-addext', `subjectAltName=DNS:${name}.test`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.crt`)], { stdio: 'ignore' });
  }
  ca = readFileSync(join(directory, 'backend.crt'), 'utf8');
  otherCA = readFileSync(join(directory, 'other.crt'), 'utf8');
  server = createServer({ key: readFileSync(join(directory, 'backend.key')), cert: ca }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    observed = { host: req.headers.host, path: req.url, method: req.method, body: Buffer.concat(chunks).toString() };
    if (req.url === '/wait') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://foreign.test/' }); res.end(); return; }
    const body = gzipSync(Buffer.from('verified backend response'));
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  rmSync(directory, { recursive: true });
});

test('managed gateway preserves TLS identity, exact HTTP target and raw compressed bytes', async () => {
  const bytes = new TextEncoder().encode('payload');
  const response = await requestManagedProxy('https://backend.test/search?q=a%2Fb', descriptor(), {
    method: 'POST', headers: new Headers({ host: 'untrusted.test', 'content-type': 'text/plain' }), body: bytes.buffer,
  }, fixtureRequest);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(Number(response.headers.get('content-length')), body.length);
  assert.equal(gunzipSync(body).toString(), 'verified backend response');
  assert.deepEqual(observed, { host: 'backend.test', path: '/search?q=a%2Fb', method: 'POST', body: 'payload' });
});

test('wrong CA and wrong TLS hostname are rejected without insecure fallback', async () => {
  await assert.rejects(requestManagedProxy('https://backend.test/', { ...descriptor(), ca: otherCA },
    { method: 'GET', headers: new Headers() }, fixtureRequest));
  await assert.rejects(requestManagedProxy('https://wrong.test/', { ...descriptor(), hostname: 'wrong.test' },
    { method: 'GET', headers: new Headers() }, fixtureRequest));
});

test('transport cannot redirect its authority to a foreign host, public address or arbitrary port', () => {
  for (const destination of ['http://backend.test/', 'https://foreign.test/', 'https://backend.test:8443/', 'https://user@backend.test/']) {
    assert.throws(() => managedProxyTransport(descriptor(), destination));
  }
  for (const address of ['127.0.0.1', '169.254.169.254', '8.8.8.8', 'localhost', '10.1.2.999']) {
    assert.throws(() => managedProxyTransport({ ...descriptor(), address }, 'https://backend.test/'));
  }
});

test('upstream redirects remain responses and an aborted caller cancels the request', async () => {
  const redirected = await requestManagedProxy('https://backend.test/redirect', descriptor(),
    { method: 'GET', headers: new Headers() }, fixtureRequest);
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), 'https://foreign.test/');
  await redirected.arrayBuffer();
  const controller = new AbortController();
  const pending = requestManagedProxy('https://backend.test/wait', descriptor(),
    { method: 'GET', headers: new Headers(), signal: controller.signal }, fixtureRequest);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
