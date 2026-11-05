import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  retainRuntime, copyRetainedRuntime, verifyRetainedRuntime, deleteRetainedRuntime,
} from '../src/lib/admission/retained-runtime';

test('retained roots require exact ownership, isolation, provider convergence and preserve recovery on failed adoption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admission-retained-'));
  const socket = join(directory, 'incus.sock');
  const binding = { appId: 'app-a', sourceName: 'app-app-a', retainedName: 'ye-retained-fixture',
    installationId: '10000000-0000-4000-8000-000000000001',
    ownerId: '10000000-0000-4000-8000-000000000002', pool: 'pool-a' };
  const tags = { 'user.youeye.app_id': binding.appId,
    'user.youeye.installation_id': binding.installationId, 'user.youeye.data_owner_id': binding.ownerId };
  const instances = new Map<string, any>([[binding.sourceName, {
    name: binding.sourceName, status: 'Running', config: { ...tags, 'boot.autostart': 'true' },
    profiles: ['default'], expanded_devices: {
      root: { type: 'disk', pool: binding.pool, path: '/' },
      eth0: { type: 'nic', network: 'app-net' },
    },
    data: 'original private content',
  }]]);
  const mutations: string[] = [];
  let converge = true;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = request.url!;
    const name = path.split('/')[3];
    let current = instances.get(name);
    if (request.method !== 'GET') mutations.push(`${request.method} ${path}`);
    if (request.method === 'POST') {
      const source = instances.get(body.source.source);
      assert.equal(body.instance_only, true);
      assert.equal(source.status, 'Stopped');
      // Incus can inherit devices: caller must perform and verify sanitization.
      current = structuredClone(source);
      current.name = body.name;
      current.config = { ...source.config, ...body.config };
      current.profiles = body.profiles;
      if (body.name === binding.sourceName) current.expanded_devices = body.devices;
      instances.set(body.name, current);
    } else if (request.method === 'PUT' && converge) {
      if (path.endsWith('/state')) current.status = 'Stopped';
      else {
        current.config = body.config;
        current.profiles = body.profiles;
        current.expanded_devices = body.devices;
      }
    } else if (request.method === 'DELETE') instances.delete(name);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(current || request.method === 'POST' || request.method === 'DELETE'
      ? { type: 'sync', metadata: current ?? {} }
      : { type: 'error', error_code: 404 }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const oldSocket = process.env.INCUS_SOCKET;
  const oldHttps = process.env.INCUS_HTTPS_URL;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await assert.rejects(retainRuntime({ ...binding, ownerId: '10000000-0000-4000-8000-000000000099' }), /foreign/);
    assert.equal(mutations.length, 0);
    await assert.rejects(retainRuntime({ ...binding, pool: 'foreign' }), /pool/);
    assert.equal(mutations.length, 0);
    await retainRuntime(binding);
    await verifyRetainedRuntime(binding);
    const retained = instances.get(binding.retainedName);
    assert.equal(retained.data, 'original private content');
    assert.equal(retained.status, 'Stopped');
    assert.deepEqual(retained.profiles, []);
    assert.deepEqual(Object.keys(retained.expanded_devices), ['root']);
    const mutationCount = mutations.length;
    await retainRuntime(binding);
    assert.equal(mutations.length, mutationCount, 'no-op readback must not duplicate a copy');
    await assert.rejects(copyRetainedRuntime(binding), /already exists/);
    assert.equal(mutations.length, mutationCount);
    instances.delete(binding.sourceName); // model removal only after verified copy
    await copyRetainedRuntime(binding, { devices: {
      eth0: { type: 'nic', network: 'new-app-net' },
      root: { type: 'disk', path: '/', pool: 'manifest-default-pool' },
    } });
    assert.equal(instances.get(binding.sourceName).expanded_devices.root.pool, binding.pool,
      'manifest defaults cannot move the retained root to another pool');
    assert.equal(instances.get(binding.sourceName).data, 'original private content');
    assert.equal(instances.get(binding.sourceName).status, 'Stopped');
    assert.equal(instances.get(binding.retainedName).data, 'original private content');
    retained.config['user.youeye.data_owner_id'] = 'foreign';
    const beforeForeignDelete = mutations.length;
    await assert.rejects(deleteRetainedRuntime(binding), /foreign/);
    assert.equal(mutations.length, beforeForeignDelete);
    retained.config['user.youeye.data_owner_id'] = binding.ownerId;
    retained.expanded_devices.bad = { type: 'proxy' };
    await assert.rejects(copyRetainedRuntime(binding), /isolated/);
    delete retained.expanded_devices.bad;
    await deleteRetainedRuntime(binding);
    assert.equal(instances.has(binding.retainedName), false);
    converge = false;
    instances.get(binding.sourceName).status = 'Running';
    await assert.rejects(retainRuntime(binding), /did not stop/);
    assert.equal(instances.has(binding.retainedName), false);
  } finally {
    if (oldSocket === undefined) delete process.env.INCUS_SOCKET; else process.env.INCUS_SOCKET = oldSocket;
    if (oldHttps === undefined) delete process.env.INCUS_HTTPS_URL; else process.env.INCUS_HTTPS_URL = oldHttps;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
