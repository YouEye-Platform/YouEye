import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrozenAppManifest } from '../src/lib/market/frozen-manifest';
import { fixtureManifest } from './fixtures/app-update-appliance';

test('direct-source backup retains the actual installed version without resolving a catalog', () => {
  const old = fixtureManifest('shared', '1.0.0');
  const read = parseFrozenAppManifest(JSON.stringify(old), old.metadata.id, '1.0.0');
  assert.equal(read.version, '1.0.0');
  assert.equal(read.containers[0].image, old.containers[0].image);
});

test('backup refuses foreign, incomplete or newer manifest registration', () => {
  const old = fixtureManifest('shared', '1.0.0');
  for (const raw of ['null', '{}', 'not-json', JSON.stringify(fixtureManifest('own'))]) {
    assert.throws(() => parseFrozenAppManifest(raw, old.metadata.id, '1.0.0'),
      { code: 'frozen-manifest-unavailable' });
  }
  assert.throws(() => parseFrozenAppManifest(JSON.stringify(old), old.metadata.id, '1.0.1'),
    { code: 'frozen-version-mismatch' });
});
