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

test('a native app from a market records the frozen digest of its manifest, so the frozen copy keeps matching', async () => {
  const { marketNativeFixture } = await import('./fixtures/app-format');
  const manifest = marketNativeFixture();
  // The market reference an install or update records names the manifest's frozen digest (catalog.ts).
  const digest = manifest.frozen!.digest;
  // The next update, backup or copy reads the frozen copy against the recorded digest; the package is part of it.
  const registration = JSON.stringify({ frozen: manifest.frozen });
  const read = parseFrozenAppManifest(registration, manifest.metadata.id, undefined, digest);
  assert.equal(read.containers[0].source?.package?.sha256, 'a'.repeat(64));
  // The raw manifest bytes' hash is refused.
  const { createHash } = await import('node:crypto');
  const raw = `sha256:${createHash('sha256').update(manifest.frozen!.manifest).digest('hex')}`;
  assert.throws(() => parseFrozenAppManifest(registration, manifest.metadata.id, undefined, raw), { code: 'frozen-digest-mismatch' });
});
