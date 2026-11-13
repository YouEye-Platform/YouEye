import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { SpineClient } from '../src/lib/spine/client';

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
  await assert.rejects(client.health(), /could not reach the Spine API through its socket/);

  const server = spineServer();
  await listen(server, socket);
  t.after(async () => close(server));

  assert.deepEqual(await client.health(), { status: 'ok' });
  assert.deepEqual(await client.version(), { version: '0.5.17.0.3', service: 'spine' });
});
