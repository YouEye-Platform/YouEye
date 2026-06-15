import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E6 — the per-app settings embed is on the ONE <UnifiedEmbed kind="settings-panel">.
// Run: node --test tests/settings-app-embed-e6.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const detail = read('src/components/settings/app-settings-detail.tsx');

test('app settings render through <UnifiedEmbed kind="settings-panel">', () => {
  assert.match(detail, /from "@\/components\/embeds\/unified-embed"/);
  assert.match(detail, /kind="settings-panel"/);
});

test('the hand-rolled iframe + legacy resize listener are gone (UnifiedEmbed owns the protocol)', () => {
  assert.doesNotMatch(detail, /<iframe/);
  // the local youeye-app-settings-resize message listener was removed (the doc
  // comment may still name it — UnifiedEmbed accepts it as legacy for one cycle)
  assert.doesNotMatch(detail, /addEventListener\("message"/);
});

test('a visible fallback is provided (never silent)', () => {
  assert.match(detail, /fallback=\{/);
  assert.match(detail, /failed to load/i);
});
