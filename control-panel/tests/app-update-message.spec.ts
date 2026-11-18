import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completedMessage } from '../src/lib/market/update-http';

test('an update that had nothing to do says so instead of "Update complete"', () => {
  assert.equal(completedMessage({ unchanged: true, newVersion: '26.11.1' }), 'Already up to date (version 26.11.1): nothing was changed.');
  assert.equal(completedMessage({ unchanged: true }), 'Already up to date: nothing was changed.');
  assert.equal(completedMessage({ newVersion: '26.11.2' }), 'Update complete');
  assert.match(completedMessage({ sharedFolders: ['media'] }), /^Update complete\. Shared folders \(media\)/);
  // The updater marks both of its no-op returns, and only those.
  const updater = readFileSync(new URL('../src/lib/market/updater.ts', import.meta.url), 'utf8');
  assert.equal(updater.match(/is already up to date/g)?.length, 2);
  assert.equal(updater.match(/migrationsRun: 0, unchanged: true \}/g)?.length, 2);
});
