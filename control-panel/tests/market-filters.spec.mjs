import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('root Market page exposes combined catalog filters', () => {
  const page = read('src/app/market/page.tsx');

  // The Market browse was restructured from a multi-dropdown filter bar
  // (searchQuery/sourceFilter/typeFilter/statusFilter) to a section-based browse:
  // a search box + a section pill bar (Apps / Installed / Updates / Integrations)
  // + a category filter. Assert the CURRENT combined-filter contract.
  assert.match(page, /const \[search, setSearch\]/);
  assert.match(page, /const \[section, setSection\]/);
  assert.match(page, /categoryFilter/);
  assert.match(page, /matchesSearch/);
  assert.match(page, /apps\.filter\(matchesSearch\)/);
  // Section labels present in the pill bar.
  assert.match(page, /All apps/);
  assert.match(page, /Integrations/);
  assert.match(page, /Installed/);
  assert.match(page, /Updates/);
  // Empty state when nothing matches the current search/section/category.
  assert.match(page, /Nothing matches your search or filters/);
});
