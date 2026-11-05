import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindAppVolumeOwnership, deleteAppStorage, verifyAppStorageOwnership } from '../src/lib/market/storage';
import type { StorageVolumeMeta } from '../src/lib/market/types';
import { bindRuntimeOwnership, verifyRuntimeOwnership } from '../src/lib/admission/runtime-ownership';

test('Incus ownership binds exact volumes, rejects foreign cleanup and verifies writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admission-storage-'));
  const socket = join(directory, 'incus.sock');
  const requests: string[] = [];
  const volume: StorageVolumeMeta = {
    appId: 'app-a', pool: 'default', name: 'ye-app-a-server-data', logicalName: 'data',
    containerName: 'app-app-a', containerPath: '/data', type: 'data', backup: true,
  };
  let current: any = { name: volume.name, type: 'custom', content_type: 'filesystem',
    config: { 'user.youeye.kind': 'app', 'user.youeye.app_id': 'app-a',
      'user.youeye.logical_name': 'data', 'user.youeye.volume_type': 'data' }, used_by: [] };
  let acceptWrite = true;
  const server = http.createServer(async (request, response) => {
    requests.push(request.method!);
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (acceptWrite) current = { ...current, ...body };
    } else if (request.method === 'DELETE') current = null;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(current || request.method === 'DELETE'
      ? { type: 'sync', metadata: current }
      : { type: 'error', error_code: 404 }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const previousSocket = process.env.INCUS_SOCKET;
  const previousHttps = process.env.INCUS_HTTPS_URL;
  const previousJournal = process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
  process.env.INCUS_SOCKET = socket;
  process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = join(directory, 'updates');
  delete process.env.INCUS_HTTPS_URL;
  const installation = '10000000-0000-4000-8000-000000000001';
  const owner = '10000000-0000-4000-8000-000000000002';
  try {
    await assert.rejects(deleteAppStorage([volume]), /resolved installation/);
    assert.equal(requests.includes('DELETE'), false);
    acceptWrite = false;
    await assert.rejects(bindAppVolumeOwnership(volume, installation, owner), /unresolved household/);
    acceptWrite = true;
    await bindAppVolumeOwnership(volume, installation, owner);
    assert.equal(volume.installationId, installation);
    const writeCount = requests.filter(method => method === 'PUT').length;
    await bindAppVolumeOwnership(volume, installation, owner);
    assert.equal(requests.filter(method => method === 'PUT').length, writeCount, 'no-op binding does not mutate provider');
    for (const change of [
      { name: 'foreign-name' }, { type: 'container' }, { content_type: 'block' },
      { config: { ...current.config, 'user.youeye.logical_name': 'foreign-logical' } },
      { config: { ...current.config, 'user.youeye.volume_type': 'config' } },
      { config: { ...current.config, 'user.youeye.installation_id': owner } },
      { config: { ...current.config, 'user.youeye.data_owner_id': installation } },
    ]) {
      const saved = current;
      current = { ...current, ...change };
      await assert.rejects(verifyAppStorageOwnership([volume]));
      await assert.rejects(deleteAppStorage([volume]));
      assert.equal(requests.includes('DELETE'), false);
      current = saved;
    }
    await verifyAppStorageOwnership([volume]);
    await deleteAppStorage([volume]);
    assert.equal(current, null);
    assert.equal(requests.filter(method => method === 'DELETE').length, 1);
  } finally {
    if (previousSocket === undefined) delete process.env.INCUS_SOCKET;
    else process.env.INCUS_SOCKET = previousSocket;
    if (previousHttps === undefined) delete process.env.INCUS_HTTPS_URL;
    else process.env.INCUS_HTTPS_URL = previousHttps;
    if (previousJournal === undefined) delete process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
    else process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = previousJournal;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime ownership refuses mismatched instances and suppresses no-op writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admission-runtime-'));
  const socket = join(directory, 'incus.sock');
  const binding = { appId: 'app-a', name: 'app-app-a',
    installationId: '10000000-0000-4000-8000-000000000001',
    ownerId: '10000000-0000-4000-8000-000000000002' };
  const current = { name: binding.name, config: {} as Record<string, string> };
  let writes = 0;
  let acceptWrite = true;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'PATCH') {
      writes++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (acceptWrite) current.config = { ...current.config, ...JSON.parse(Buffer.concat(chunks).toString()).config };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ type: 'sync', metadata: current }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const previousSocket = process.env.INCUS_SOCKET;
  const previousHttps = process.env.INCUS_HTTPS_URL;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await assert.rejects(verifyRuntimeOwnership(binding), /unknown or foreign/);
    acceptWrite = false;
    await assert.rejects(bindRuntimeOwnership(binding), /unknown or foreign/);
    acceptWrite = true;
    await bindRuntimeOwnership(binding);
    const previousWrites = writes;
    await bindRuntimeOwnership(binding);
    assert.equal(writes, previousWrites);
    for (const [key, value] of [
      ['user.youeye.app_id', 'foreign-app'],
      ['user.youeye.installation_id', binding.ownerId],
      ['user.youeye.data_owner_id', binding.installationId],
    ]) {
      const saved = current.config[key];
      current.config[key] = value;
      await assert.rejects(bindRuntimeOwnership(binding), /foreign ownership/);
      await assert.rejects(verifyRuntimeOwnership(binding), /unknown or foreign/);
      assert.equal(writes, previousWrites);
      current.config[key] = saved;
    }
    current.name = 'foreign-instance';
    await assert.rejects(verifyRuntimeOwnership(binding), /mismatched/);
  } finally {
    if (previousSocket === undefined) delete process.env.INCUS_SOCKET;
    else process.env.INCUS_SOCKET = previousSocket;
    if (previousHttps === undefined) delete process.env.INCUS_HTTPS_URL;
    else process.env.INCUS_HTTPS_URL = previousHttps;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
