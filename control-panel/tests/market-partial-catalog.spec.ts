import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalogEntries } from '../src/lib/market/partial-catalog';

test('a missing native manifest preserves the remaining apps in catalog order', async () => {
  const failed: string[] = [];
  const apps = await loadCatalogEntries(['wiki', 'notes', 'search'], async (id) => {
    if (id === 'wiki') throw new Error('HTTP 404');
    if (id === 'notes') await new Promise((resolve) => setTimeout(resolve, 5));
    return id;
  }, (id) => failed.push(id));
  assert.deepEqual(apps, ['notes', 'search']);
  assert.deepEqual(failed, ['wiki']);
});

test('all failed entries remain distinguishable from an empty catalog', async () => {
  const failed: string[] = [];
  assert.deepEqual(await loadCatalogEntries(['broken'], async () => { throw new Error('invalid manifest'); }, id => failed.push(id)), []);
  assert.deepEqual(failed, ['broken']);
  assert.deepEqual(await loadCatalogEntries([], async (id) => id, () => assert.fail('empty catalog is not a failure')), []);
});
