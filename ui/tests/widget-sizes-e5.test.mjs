import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E5 — dashboard widgets on the unified embed + app-declared size bounds.
// Run: node --test tests/widget-sizes-e5.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('app widgets render through <UnifiedEmbed kind="widget" fill> (hand-rolled iframe gone)', () => {
  const w = read('src/components/widgets/app-widget.tsx');
  assert.match(w, /from "@\/components\/embeds\/unified-embed"/);
  assert.match(w, /kind="widget"/);
  assert.match(w, /\bfill\b/);
  assert.match(w, /fetch\("\/api\/v1\/apps\/surfaces"\)/);
  assert.match(w, /item\.kind === "widget"/);
  assert.match(w, /new URL\(surface\.embed_path, surface\.app_url\)/);
  assert.doesNotMatch(w, /<iframe/);          // no bespoke iframe
  assert.doesNotMatch(w, /\/api\/v1\/apps\/drawer/);
  assert.match(w, /fallback=/);                // never silent
});

test('UnifiedEmbed supports a fill mode (100% height for fixed-size hosts)', () => {
  const u = read('src/components/embeds/unified-embed.tsx');
  assert.match(u, /fill\?: boolean/);
  assert.match(u, /fill \? "100%" : height/);  // iframe height
});

test('resize is clamped to the widget declared min/max (not just a global floor)', () => {
  const g = read('src/components/dashboard/widget-grid.tsx');
  assert.match(g, /function clampWidgetSize/);
  assert.match(g, /meta\?\.minSize/);
  assert.match(g, /meta\?\.maxSize/);
  // handleSizeChange runs the clamp
  assert.match(g, /clampWidgetSize\(w, width, height\)/);
});

test('app widgets carry their declared bounds (min_size/max_size) into settings on add', () => {
  const g = read('src/components/dashboard/widget-grid.tsx');
  assert.match(g, /min_size\?: \{ width: number; height: number \}/);
  assert.match(g, /max_size\?: \{ width: number; height: number \}/);
  assert.match(g, /fetch\("\/api\/v1\/apps\/surfaces"\)/);
  assert.match(g, /surface\.kind === "widget"/);
  assert.match(g, /surface\.placement === "dashboard"/);
  assert.match(g, /default_size: asSize\(surface\.default_size\)/);
  assert.match(g, /_minSize: appWidgetDef\.min_size/);
  assert.match(g, /_maxSize: appWidgetDef\.max_size/);
});

test('app widget previews use app_url and embed_path from surfaces, not drawer lookup', () => {
  const dialog = read('src/components/dashboard/add-widget-dialog.tsx');
  assert.match(dialog, /appUrl=\{item\.appWidgetDef\.app_url\}/);
  assert.match(dialog, /embedPath=\{item\.appWidgetDef\.embed_path\}/);
  assert.match(dialog, /new URL\(embedPath, appUrl\)/);
  assert.doesNotMatch(dialog, /\/api\/v1\/apps\/drawer/);
});
