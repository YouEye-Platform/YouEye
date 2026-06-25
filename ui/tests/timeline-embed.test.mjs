import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E2 — timeline embed migrated onto the unified <UnifiedEmbed>.
// Run: node --test tests/timeline-embed.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('timeline entry renders via <UnifiedEmbed kind="timeline-card">', () => {
  const t = read('src/components/timeline/timeline-embed.tsx');
  assert.match(t, /from "@\/components\/embeds\/unified-embed"/);
  assert.match(t, /<UnifiedEmbed/);
  assert.match(t, /kind="timeline-card"/);
});

test('the old 200px height cap is dropped (generous 480 guard)', () => {
  const t = read('src/components/timeline/timeline-embed.tsx');
  assert.match(t, /EMBED_MAX_HEIGHT = 480/);
  assert.doesNotMatch(t, /EMBED_MAX_HEIGHT = 200/);
});

test('hand-rolled iframe + legacy message handling removed (UnifiedEmbed owns the protocol)', () => {
  const t = read('src/components/timeline/timeline-embed.tsx');
  assert.doesNotMatch(t, /youeye-embed-ready/);
  assert.doesNotMatch(t, /addEventListener\("message"/);
  assert.doesNotMatch(t, /<iframe/);
});

test('visible StandardCard fallback with redesigned uninstalled copy (never silent)', () => {
  const t = read('src/components/timeline/timeline-embed.tsx');
  assert.match(t, /fallback=\{<StandardCard/);
  assert.match(t, /uninstalled \/>/);            // the fallback passes uninstalled
  assert.match(t, /This app was uninstalled/);   // redesigned copy
});
