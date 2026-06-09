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

  assert.match(page, /searchQuery/);
  assert.match(page, /sourceFilter/);
  assert.match(page, /typeFilter/);
  assert.match(page, /statusFilter/);
  assert.match(page, /categoryFilter/);
  assert.match(page, /sourceOptions = Array\.from/);
  assert.match(page, /filteredApps = apps\.filter/);
  assert.match(page, /All Markets/);
  assert.match(page, /Native Apps/);
  assert.match(page, /External Apps/);
  assert.match(page, /Integrations/);
  assert.match(page, /Installed/);
  assert.match(page, /Available/);
  assert.match(page, /Updates/);
  assert.match(page, /Showing \{filteredApps\.length\} of \{apps\.length\} Market items/);
  assert.match(page, /No Market items match these filters/);
});
