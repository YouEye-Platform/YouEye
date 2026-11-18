import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = async (path) => { const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8'); return path.endsWith('.tsx') ? englishInterfaceSource(text) : text; };

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
