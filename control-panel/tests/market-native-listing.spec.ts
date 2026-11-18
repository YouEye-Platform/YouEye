/**
 * Listing the Market does not download a native app's release document and manifest again while the box's channel
 * index still names the same release (native-artifact.ts `nativeListing`).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nativeListing, resetNativeListings, resolveNativeProduct } from '../src/lib/market/native-artifact';
import { readChannelIndex } from '../src/lib/releases/channel-index';
import { appYAML } from './fixtures/app-format';
import { withMarketState } from './fixtures/market-world';
import { fakeReleaseHost, productFixture, spineIndex } from './fixtures/release-fixtures';

const youeye = 'https://git.example.test/owner/YouEye';
const notesRepo = 'https://git.example.test/owner/YE-App-Notes';

function notesRelease(version: string, name = 'Notes') {
  const contract = Buffer.from(appYAML({ id: 'notes', name, image: undefined, source: { node: '24' }, port: 3000, health: '/api/health' }));
  const archive = Buffer.from(`notes ${version}`);
  const f = productFixture('notes', version, notesRepo, { 'standalone.tar': archive, 'youeye-app.yaml': contract }, { contract });
  const base = `${notesRepo}/releases/download/v${version}`;
  return { f, version, files: new Map<string, Buffer>([[`${base}/product-release.json`, f.raw], [`${base}/youeye-app.yaml`, contract], [`${base}/standalone.tar`, archive]]) };
}

test('a native app\'s listing is downloaded once per release of the channel, and kept across restarts', withMarketState(async (directory) => {
  resetNativeListings();
  const first = notesRelease('0.6.3-dev.1');
  const second = notesRelease('0.6.3-dev.2', 'Notes II');
  const host = fakeReleaseHost(new Map([...first.files, ...second.files]));
  let current = first;
  let indexReads = 0;
  const deps = {
    index: () => { indexReads += 1; return readChannelIndex({ getReleaseIndex: async () => spineIndex(youeye, 'dev', { notes: { repository: notesRepo, tag: current.f.tag, version: current.version, raw: current.f.raw } }) }); },
    fetch: host.fetch,
  };

  const listed = await nativeListing('notes', deps);
  assert.equal(listed.manifest.metadata.id, 'notes');
  assert.equal(listed.manifest.integration, 'native');
  assert.equal(listed.manifest.version, '0.6.3-dev.1', 'versioned by the release');
  assert.equal(listed.selected.release.tag, 'v0.6.3-dev.1');
  assert.deepEqual(host.requests.splice(0).map((url) => path.basename(url)), ['product-release.json', 'youeye-app.yaml']);

  // Twenty more listings: the index is asked (Spine caches it), the release host is not.
  for (let n = 0; n < 20; n += 1) await nativeListing('notes', deps);
  assert.equal(host.requests.length, 0);
  assert.ok(indexReads >= 21);
  // A caller may change what it got.
  listed.manifest.metadata.name = 'changed';
  assert.equal((await nativeListing('notes', deps)).manifest.metadata.name, 'Notes');

  // After a restart the kept copy answers, checked against the index entry again.
  resetNativeListings();
  assert.equal((await nativeListing('notes', deps)).manifest.version, '0.6.3-dev.1');
  assert.equal(host.requests.length, 0);
  // A kept copy that was changed on disk is not used: the files are downloaded and checked again.
  const file = path.join(directory, 'markets', '_native', 'notes.json');
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...kept, contract_base64: Buffer.from(appYAML({ id: 'notes', name: 'Evil', image: undefined, source: { node: '24' }, port: 3000, health: '/api/health' })).toString('base64') }));
  resetNativeListings();
  assert.equal((await nativeListing('notes', deps)).manifest.metadata.name, 'Notes');
  assert.equal(host.requests.splice(0).length, 2);

  // The channel names a new release: its listing is fetched once.
  current = second;
  const updated = await nativeListing('notes', deps);
  assert.equal(updated.manifest.version, '0.6.3-dev.2');
  assert.equal(updated.manifest.metadata.name, 'Notes II');
  assert.equal(host.requests.splice(0).length, 2);
  await nativeListing('notes', deps);
  assert.equal(host.requests.length, 0);

  // A product the channel does not have, and a document that is not what the index names.
  await assert.rejects(nativeListing('wiki', deps), /This channel has no wiki release yet/);
  resetNativeListings();
  writeFileSync(file, '{}');
  const tampered = { ...deps, index: () => readChannelIndex({ getReleaseIndex: async () => spineIndex(youeye, 'dev', { notes: { repository: notesRepo, tag: second.f.tag, version: second.version, raw: Buffer.from('other') } }) }) };
  await assert.rejects(nativeListing('notes', tampered), /differs from the channel index digest/);

  // Installs and updates do not use the kept listing: they resolve the release themselves, as before.
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src/lib/market/native-artifact.ts'), 'utf8');
  assert.match(source.slice(source.indexOf('export async function resolveNativeProduct'), source.indexOf('export async function nativeManifestFromContract')), /resolveChannelProduct\(product\)/);
  assert.equal(typeof resolveNativeProduct, 'function');
  for (const file of ['src/lib/market/engine.ts', 'src/lib/market/updater.ts', 'src/lib/infrastructure/lxd-deployer.ts']) {
    assert.doesNotMatch(readFileSync(path.join(import.meta.dirname, '..', file), 'utf8'), /nativeListing\(/, file);
  }
}));
