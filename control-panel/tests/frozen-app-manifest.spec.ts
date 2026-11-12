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

test('a native app update records the frozen digest the install records, so the frozen copy keeps matching', async () => {
  const { nativeFixture } = await import('./fixtures/app-format');
  const { nativeManifestReference } = await import('../src/lib/market/native-artifact');
  const manifest = nativeFixture();
  const selected = { repository: 'https://git.example/apps/demo', release: { tag: 'demo-v1.2.0', version: '1.2.0' } };
  const reference = nativeManifestReference(selected as never, manifest);
  assert.equal(reference.digest, manifest.frozen!.digest);
  // The next update, backup or copy reads the frozen copy against the recorded digest.
  const registration = JSON.stringify({ frozen: manifest.frozen });
  assert.equal(parseFrozenAppManifest(registration, manifest.metadata.id, undefined, reference.digest).metadata.id, manifest.metadata.id);
  // The raw contract bytes' hash (what updates used to record) is refused.
  const { createHash } = await import('node:crypto');
  const raw = `sha256:${createHash('sha256').update(manifest.frozen!.manifest).digest('hex')}`;
  assert.throws(() => parseFrozenAppManifest(registration, manifest.metadata.id, undefined, raw), { code: 'frozen-digest-mismatch' });
});
