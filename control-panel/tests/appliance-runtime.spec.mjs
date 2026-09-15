import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('system settings consumes Spine runtime capabilities and persistent state', async () => {
  const [route, client] = await Promise.all([
    read('src/app/api/settings/system/route.ts'),
    read('src/components/settings-shell/system-client.tsx'),
  ]);
  assert.match(route, /spineClient\.status\(\)/);
  assert.match(route, /persistent_state:/);
  assert.match(client, /data\.runtime\.kind === "appliance-image"/);
  assert.match(client, /name: "System image"/);
  assert.match(client, /Image-managed/);
  assert.match(client, /isAppliance &&/);
});

test('unsupported host updates remain typed 409 product state', async () => {
  const [spineClient, updateRoute] = await Promise.all([
    read('src/lib/spine/client.ts'),
    read('src/app/api/updates/[component]/route.ts'),
  ]);
  assert.match(spineClient, /class SpineAPIError/);
  assert.match(spineClient, /public readonly statusCode: number/);
  assert.match(updateRoute, /capability_not_supported/);
  assert.match(updateRoute, /error\.statusCode === 409/);
  assert.match(updateRoute, /\{ status: 409 \}/);
});
