import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SpineClient } from '../src/lib/spine/client';

const digest = 'a'.repeat(64);
const exactSelection = {
  provider: 'forgejo' as const,
  releases_api: 'https://forgejo.example.test/api/v1/repos/youeye/YouEye/releases',
  channel: 'exact' as const,
  exact_tag: 'appliance-dev-v1.2.3',
  manifest_sha256: digest,
};

async function withSpineServer(
  responder: (request: http.IncomingMessage, body: Record<string, unknown>, index: number) => {
    status: number;
    body: Record<string, unknown>;
  },
  run: (client: SpineClient, requests: Record<string, unknown>[]) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'youeye-spine-client-'));
  const socket = join(directory, 'spine.sock');
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      requests.push(body);
      const result = responder(request, body, requests.length - 1);
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  try {
    await run(new SpineClient(socket), requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('exact update retries the preceding Spine schema without provider fields', async () => {
  await withSpineServer(
    (_request, _body, index) => index === 0
      ? { status: 400, body: { error: 'a valid manifest request is required' } }
      : {
          status: 200,
          body: {
            schema: 'youeye.system-update.v1', state: 'available', current_image: '1.2.2',
            running_image: '1.2.2', target_image: '1.2.3', active_slot: 'A',
            reboot_required: false, rolled_back: false,
          },
        },
    async (client, requests) => {
      const status = await client.checkApplianceSystemUpdate(exactSelection);
      assert.equal(status.state, 'available');
      assert.deepEqual(requests, [
        exactSelection,
        { channel: 'exact', exact_tag: exactSelection.exact_tag, manifest_sha256: digest },
      ]);
    },
  );
});

test('staging preserves replace-failed confirmation across the exact compatibility retry', async () => {
  await withSpineServer(
    (_request, _body, index) => index === 0
      ? { status: 400, body: { error: 'a valid manifest request is required' } }
      : {
          status: 200,
          body: {
            schema: 'youeye.system-update.v1', state: 'staged', current_image: '1.2.2',
            running_image: '1.2.2', target_image: '1.2.3', active_slot: 'A',
            reboot_required: false, rolled_back: false,
          },
        },
    async (client, requests) => {
      const status = await client.stageApplianceSystemUpdate({ ...exactSelection, replace_failed: true });
      assert.equal(status.state, 'staged');
      assert.deepEqual(requests[1], {
        channel: 'exact', exact_tag: exactSelection.exact_tag,
        manifest_sha256: digest, replace_failed: true,
      });
    },
  );
});

test('automatic channels never fall back to a different sealed-in release source', async () => {
  await withSpineServer(
    () => ({ status: 400, body: { error: 'a valid manifest request is required' } }),
    async (client, requests) => {
      await assert.rejects(() => client.checkApplianceSystemUpdate({
        provider: 'forgejo',
        releases_api: exactSelection.releases_api,
        channel: 'development',
      }), /a valid manifest request is required/);
      assert.equal(requests.length, 1);
    },
  );
});

test('unrelated validation errors are not hidden by the compatibility path', async () => {
  await withSpineServer(
    () => ({ status: 400, body: { error: 'release tag is invalid' } }),
    async (client, requests) => {
      await assert.rejects(() => client.checkApplianceSystemUpdate(exactSelection), /release tag is invalid/);
      assert.equal(requests.length, 1);
    },
  );
});
