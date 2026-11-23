import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return path.endsWith(".tsx") ? englishInterfaceSource(readFileSync(join(repoRoot, path), "utf8")) : readFileSync(join(repoRoot, path), "utf8");
}

test('root Market page exposes combined catalog filters', () => {
  const page = read('src/app/market/page.tsx');

  // The Market is one grid of apps: a search box + category chips (with "Added by address" when there are such
  // apps). Installed apps and updates moved to Settings → Apps. Search and category are kept in the address.
  assert.match(page, /const \[search, setSearch\]/);
  assert.match(page, /const \[category, setCategory\]/);
  assert.match(page, /const matches = \(app: MarketApp\) =>/);
  assert.match(page, /\.filter\(matches\)/);
  assert.match(page, /category === 'all' \|\| category === 'added' \|\| \(app\.category \|\| 'other'\) === category/);
  assert.match(page, /params\.set\('q', search\.trim\(\)\)/);
  assert.match(page, /params\.set\('category', category\)/);
  // Empty state when nothing matches the current search/category.
  assert.match(page, /Nothing matches your search or filters/);
});
