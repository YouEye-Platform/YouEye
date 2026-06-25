import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

const marketFiles = [
  'src/lib/market/catalog.ts',
  'src/lib/market/updater.ts',
  'src/lib/market/installed-apps.ts',
  'src/app/api/market/source/route.ts',
];

test('market code does not read Spine core release source', () => {
  for (const file of marketFiles) {
    const text = read(file);
    assert.equal(text.includes('@/lib/apps/release-source'), false, `${file} must not import the core Spine release source`);
    assert.equal(text.includes("from './release-source'"), false, `${file} must not import a release-source sibling`);
    assert.equal(text.includes('config.release_source'), false, `${file} must not read Spine release_source`);
  }
});

test('market source is CP-owned', () => {
  const source = read('src/lib/market/source.ts');
  assert.match(source, /market-source\.json/);
  assert.match(source, /DEFAULT_MARKET_REPO_URL/);
});

test('core release source understands Spine repo_url', () => {
  const core = read('src/lib/apps/release-source.ts');
  assert.match(core, /source\?\.repo_url/);
});
