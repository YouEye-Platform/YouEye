import assert from 'node:assert/strict';
import test from 'node:test';
import { channelEntryDocumentURL,
  ReleaseFileNotFound, ReleaseHostRateLimited, assertReleaseDownloadURL, describeReleaseError, downloadProductAsset,
  downloadReleaseFile, isReleaseRateLimited, parseChannelIndex, readChannelIndex, releaseHTTPError, resetReleaseHostBackoff, resolveChannelProduct,
} from '../src/lib/releases/channel-index';
import { SpineAPIError } from '../src/lib/spine/client';
import { fakeReleaseHost, productFixture, spineIndex } from './fixtures/release-fixtures';

const youeye = 'https://git.example.test/owner/YouEye';
const pointerRepo = 'https://git.example.test/owner/Pointer';

function pointerRelease() {
  const archive = Buffer.from('pointer standalone archive');
  const contract = Buffer.from('id: pointer\n');
  const f = productFixture('pointer', '0.6.1-dev.2', pointerRepo, { 'standalone.tar': archive, 'youeye-app.yaml': contract }, { contract });
  const files = new Map<string, Buffer>([
    [`${pointerRepo}/releases/download/v0.6.1-dev.2/product-release.json`, f.raw],
    [`${pointerRepo}/releases/download/v0.6.1-dev.2/standalone.tar`, archive],
    [`${pointerRepo}/releases/download/v0.6.1-dev.2/youeye-app.yaml`, contract],
  ]);
  return { f, archive, files };
}

test('products resolve through the box channel index with plain downloads only', async () => {
  const { f, archive, files } = pointerRelease();
  const host = fakeReleaseHost(files);
  const answer = spineIndex(youeye, 'dev', { pointer: { repository: pointerRepo, tag: f.tag, version: '0.6.1-dev.2', raw: f.raw } });
  const index = () => readChannelIndex({ getReleaseIndex: async () => answer });
  const box = await index();
  assert.equal(box.repository, youeye);
  assert.equal(box.channel, 'dev');

  const selected = (await resolveChannelProduct('pointer', { index, fetch: host.fetch }))!;
  assert.equal(selected.repository, pointerRepo);
  assert.equal(selected.release.tag, 'v0.6.1-dev.2');
  assert.deepEqual(await downloadProductAsset(selected, 'standalone.tar', 1024, host.fetch), archive);
  const empty = spineIndex(youeye, 'dev', {});
  assert.equal(await resolveChannelProduct('pointer', { index: () => readChannelIndex({ getReleaseIndex: async () => empty }), fetch: host.fetch }), null,
    'a product missing from the index is not on this channel yet');
  // Native apps are Market apps since 0.6.20 (YE-142): they are no channel product, whatever the index still names.
  await assert.rejects(resolveChannelProduct('notes', { index, fetch: host.fetch }), /notes is not a channel product/);
  assert.ok(host.requests.every((url) => url.includes('/releases/download/')), host.requests.join('\n'));

  // The document must match the index digest exactly.
  const tampered = spineIndex(youeye, 'dev', { pointer: { repository: pointerRepo, tag: f.tag, version: '0.6.1-dev.2', raw: Buffer.from('other') } });
  await assert.rejects(resolveChannelProduct('pointer', { index: () => readChannelIndex({ getReleaseIndex: async () => tampered }), fetch: host.fetch }), /channel index digest/);
  await assert.rejects(resolveChannelProduct('youeye', { index, fetch: host.fetch }), /not a channel product/);
  // The entry's version must be the document's; its temporary `build` (for readers up to 0.6.11) is ignored.
  const otherBuild = spineIndex(youeye, 'dev', { pointer: { repository: pointerRepo, tag: f.tag, version: '0.6.1-dev.2', build: '0.6.1-dev.3', raw: f.raw } });
  assert.equal((await resolveChannelProduct('pointer', { index: () => readChannelIndex({ getReleaseIndex: async () => otherBuild }), fetch: host.fetch }))!.release.version, '0.6.1-dev.2');
  const wrongVersion = spineIndex(youeye, 'dev', { pointer: { repository: pointerRepo, tag: f.tag, version: '0.6.1-dev.2', raw: f.raw } });
  (wrongVersion.index.products.pointer as { version: string }).version = '0.6.1-dev.3';
  await assert.rejects(resolveChannelProduct('pointer', { index: () => readChannelIndex({ getReleaseIndex: async () => wrongVersion }), fetch: host.fetch }), /must name|channel index version/);
});

test('no code path reaches a release-listing API', async () => {
  const host = fakeReleaseHost(new Map());
  for (const url of [
    'https://api.github.com/repos/YouEye-Platform/Notes/releases?per_page=50',
    'https://git.example.test/api/v1/repos/owner/Notes/releases?limit=50',
  ]) {
    assert.throws(() => assertReleaseDownloadURL(url), /listing APIs|exact HTTPS/);
    await assert.rejects(downloadReleaseFile(url, 1024, host.fetch));
  }
  assert.equal(host.requests.length, 0);
  // A redirect into a listing API is refused.
  const redirecting = (async () => new Response(null, { status: 302, headers: { location: 'https://api.github.com/repos/o/r/releases' } })) as typeof fetch;
  await assert.rejects(downloadReleaseFile(`${pointerRepo}/releases/download/v1.0.0/standalone.tar`, 1024, redirecting), /listing API/);
});

test('HTTP 403/429 is rate limiting with back-off, never a network failure', async () => {
  const url = `${pointerRepo}/releases/download/v0.6.1-dev.2/product-release.json`;
  for (const status of [403, 429]) {
    resetReleaseHostBackoff();
    const host = fakeReleaseHost(new Map([[url, Buffer.from('x')]]), { [url]: status });
    const error = await downloadReleaseFile(url, 1024, host.fetch).catch((e) => e);
    assert.ok(error instanceof ReleaseHostRateLimited, String(error));
    assert.ok(isReleaseRateLimited(error));
    assert.match(describeReleaseError(error), /release host refused or rate-limited the request, retrying/);
    assert.doesNotMatch(describeReleaseError(error), /network/i);
    assert.match(error.message, /next attempt in 30 s/);
    // Within the back-off window the host is not asked again.
    await assert.rejects(downloadReleaseFile(url, 1024, host.fetch), ReleaseHostRateLimited);
    assert.equal(host.requests.length, 1);
  }
  resetReleaseHostBackoff();
  assert.ok(releaseHTTPError(404, url) instanceof ReleaseFileNotFound);
  assert.equal(isReleaseRateLimited(releaseHTTPError(500, url)), false);
  // Spine's classification of its own index fetch carries through.
  const spineError = new SpineAPIError('HTTP 429 from github.com', 502, 'rate_limited');
  assert.ok(isReleaseRateLimited(spineError));
  await assert.rejects(readChannelIndex({ getReleaseIndex: async () => { throw spineError; } }), ReleaseHostRateLimited);
  assert.equal(isReleaseRateLimited(new SpineAPIError('down', 502, 'unavailable')), false);
});

test('channel index entries follow the contract', () => {
  const base = spineIndex(youeye, 'stable', {}).index;
  const entry = { repository: pointerRepo, tag: 'v0.6.1-dev.2', version: '0.6.1-dev.2', build: '0.6.1-dev.2', document: 'product-release.json', sha256: 'a'.repeat(64) };
  const core = { ...entry, repository: youeye, tag: 'youeye-v0.6.1-dev.2', document: 'core-release.json' };
  assert.doesNotThrow(() => parseChannelIndex({ ...base, products: { pointer: entry } }));
  assert.doesNotThrow(() => parseChannelIndex({ ...base, products: { youeye: core } }));
  assert.throws(() => parseChannelIndex({ ...base, channel: 'feature' }), /Unsupported/);
  // Unknown products and fields are ignored; a bad entry fails only its product.
  const invalid = (products: Record<string, unknown>) => parseChannelIndex({ ...base, products: { ...products, youeye: core } });
  assert.deepEqual(Object.keys(invalid({ canvas: entry, photos: entry }).products), ['youeye']);
  // The native apps' entries, frozen for boxes up to 0.6.19, are skipped like any product this reader does not list.
  const frozen = invalid({ notes: entry, wiki: { nonsense: true }, search: entry, translate: entry, weather: entry, cinema: entry });
  assert.deepEqual([Object.keys(frozen.products), frozen.invalid], [['youeye'], {}]);
  assert.equal(invalid({ pointer: { ...entry, url: 'x', size_bytes: 1 } }).products.pointer.tag, 'v0.6.1-dev.2');
  assert.match(invalid({ pointer: { ...entry, tag: 'dev-v0.6.1-dev.2' } }).invalid.pointer, /must name/);
  assert.match(invalid({ pointer: { ...entry, repository: `${pointerRepo}/` } }).invalid.pointer, /invalid/);
  assert.match(invalid({ pointer: { ...entry, download_base: 'https://m.test/f?sig=1' } }).invalid.pointer, /invalid/);
  assert.equal(invalid({ pointer: 7 }).products.youeye.version, '0.6.1-dev.2');
  // `build` is optional and ignored (a temporary field for readers up to 0.6.11; entries from 0.6.13 have build = version).
  const { build: _omitted, ...withoutBuild } = entry;
  assert.deepEqual(invalid({ pointer: withoutBuild }).invalid, {});
  assert.equal(Object.hasOwn(invalid({ pointer: { ...entry, build: 'anything' } }).products.pointer, 'build'), false);
  assert.doesNotThrow(() => parseChannelIndex({ ...base, extra: { future: true } }));
  assert.throws(() => parseChannelIndex({ ...base, schema: 'youeye.channel.v2' }), /Unsupported/);
  // A download base moves the document off the repository layout.
  const mirrored = parseChannelIndex({ ...base, products: { pointer: { ...entry, download_base: 'https://releases.example.test/files' } } }).products.pointer;
  assert.equal(channelEntryDocumentURL(mirrored), 'https://releases.example.test/files/v0.6.1-dev.2/product-release.json');
  assert.doesNotThrow(() => parseChannelIndex({ ...base, products: { pointer: { ...entry, tag: 'v0.6.1', version: '0.6.1' } } }));
});

test('an index that still carries a market entry parses; the Market is not a channel product any more', async () => {
  // An index may still carry the frozen `market` entry (Market 0.6.4) for boxes up to 0.6.10 (removed with 0.6.13).
  const { f, files } = pointerRelease();
  const frozen = { repository: 'https://github.com/YouEye-Platform/Market', tag: 'catalog-v0.6.4', version: '0.6.4', build: '0.6.4-dev.2', document: 'product-release.json', sha256: 'c'.repeat(64) };
  const answer = spineIndex(youeye, 'stable', { pointer: { repository: pointerRepo, tag: f.tag, version: '0.6.1-dev.2', raw: f.raw } });
  (answer.index.products as Record<string, unknown>).market = frozen;
  const box = await readChannelIndex({ getReleaseIndex: async () => answer });
  assert.deepEqual(Object.keys(box.index.products), ['pointer'], 'the market entry is skipped like any product this reader does not list');
  assert.deepEqual(box.index.invalid, {});
  // Even a market entry this reader would have called malformed fails nothing.
  const odd = parseChannelIndex({ ...answer.index, products: { ...answer.index.products, market: { nonsense: true } } });
  assert.deepEqual(odd.invalid, {});
  assert.equal(odd.products.pointer.version, '0.6.1-dev.2');
  // The other products of that index resolve as before; the Market cannot be asked for.
  const host = fakeReleaseHost(files);
  const index = () => readChannelIndex({ getReleaseIndex: async () => answer });
  assert.equal((await resolveChannelProduct('pointer', { index, fetch: host.fetch }))!.release.tag, 'v0.6.1-dev.2');
  await assert.rejects(resolveChannelProduct('market', { index, fetch: host.fetch }), /market is not a channel product/);
  assert.ok(host.requests.every((url) => !/Market|catalog/.test(url)), host.requests.join('\n'));
});
