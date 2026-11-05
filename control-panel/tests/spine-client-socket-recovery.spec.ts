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

test('socket compatibility fallback re-evaluates canonical path after startup race', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-client-'));
  const canonical = join(root, 'youeye.sock');
  const legacy = join(root, 'spine.sock');
  const legacyServer = spineServer();
  await listen(legacyServer, legacy);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const client = new SpineClient('', { canonical, legacy });
  assert.deepEqual(await client.health(), { status: 'ok' });

  await close(legacyServer);
  const canonicalServer = spineServer();
  await listen(canonicalServer, canonical);
  t.after(async () => close(canonicalServer));

  assert.deepEqual(await client.version(), { version: '0.5.17.0.3', service: 'spine' });
});

test('explicit Spine socket remains authoritative without legacy fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-spine-explicit-'));
  const explicit = join(root, 'missing.sock');
  const legacy = join(root, 'legacy.sock');
  const legacyServer = spineServer();
  await listen(legacyServer, legacy);
  t.after(async () => {
    await close(legacyServer);
    await rm(root, { recursive: true, force: true });
  });

  const client = new SpineClient(explicit, { canonical: explicit, legacy });
  await assert.rejects(client.health(), /configured socket paths/);
});
