import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SpineClient, SpineTransportError } from '../src/lib/spine/client';

async function listen(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function spineServer(): http.Server {
  return http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/health') {
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.end(JSON.stringify({ version: '0.5.17.0.3', service: 'spine' }));
  });
}

test('each request re-evaluates the Spine socket after a startup race', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-client-'));
  const socket = join(root, 'youeye.sock');
  t.after(async () => rm(root, { recursive: true, force: true }));

  const client = new SpineClient(socket);
  // The message other callers show is unchanged, and it is still a request that got no answer from Spine: the
  // backup's drive store keeps its set on exactly that (until 0.6.15 this was a plain Error and the set was deleted).
  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof SpineTransportError, 'a socket that is not there is a transport error');
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /^Control Panel could not reach the Spine API through its socket \(.*youeye\.sock\): Spine API transport error: /);
    return true;
  });

  const server = spineServer();
  await listen(server, socket);
  t.after(async () => close(server));

  assert.deepEqual(await client.health(), { status: 'ok' });
  assert.deepEqual(await client.version(), { version: '0.5.17.0.3', service: 'spine' });
});

// A Spine that does not answer within the request's limit did not refuse anything either.
test('a request Spine never answers ends as a transport error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-client-'));
  const socket = join(root, 'youeye.sock');
  const server = http.createServer(() => { /* never answers */ });
  await listen(server, socket);
  t.after(async () => {
    server.closeAllConnections();
    await close(server);
    await rm(root, { recursive: true, force: true });
  });
  const original = http.ClientRequest.prototype.setTimeout;
  t.mock.method(http.ClientRequest.prototype, 'setTimeout', function (this: http.ClientRequest, _ms: number, callback?: () => void) {
    return original.call(this, 50, callback);
  });

  await assert.rejects(new SpineClient(socket).health(), (error: unknown) => {
    assert.ok(error instanceof SpineTransportError, 'a timeout is a transport error');
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.message, 'Request timeout');
    return true;
  });
});

test('a socket file nobody listens on is a transport error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-client-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stale = join(root, 'stale.sock');
  await writeFile(stale, '');
  await assert.rejects(new SpineClient(stale).health(), (error: unknown) => {
    assert.ok(error instanceof SpineTransportError);
    assert.ok(['ECONNREFUSED', 'ENOTSOCK'].includes(error.code ?? ''), `code ${error.code}`);
    assert.match(error.message, /could not reach the Spine API through its socket/);
    return true;
  });
});
