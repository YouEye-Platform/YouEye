import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReleaseFileNotFound, ReleaseHostRateLimited, assertReleaseDownloadURL, describeReleaseError, downloadProductAsset,
  downloadReleaseFile, isReleaseRateLimited, parseChannelIndex, readChannelIndex, releaseHTTPError, resetReleaseHostBackoff, resolveChannelProduct,
} from '../src/lib/releases/channel-index';
import { SpineAPIError } from '../src/lib/spine/client';
import { fakeReleaseHost, productFixture, spineIndex } from './fixtures/release-fixtures';

const youeye = 'https://git.example.test/owner/YouEye';
const notesRepo = 'https://git.example.test/owner/YE-App-Notes';

function notesRelease() {
  const archive = Buffer.from('notes standalone archive');
  const contract = Buffer.from('id: notes\n');
  const f = productFixture('notes', '0.6.1-dev.2', notesRepo, { 'standalone.tar': archive, 'youeye-app.yaml': contract }, { contract });
  const files = new Map<string, Buffer>([
    [`${notesRepo}/releases/download/v0.6.1-dev.2/product-release.json`, f.raw],
    [`${notesRepo}/releases/download/v0.6.1-dev.2/standalone.tar`, archive],
    [`${notesRepo}/releases/download/v0.6.1-dev.2/youeye-app.yaml`, contract],
  ]);
  return { f, archive, files };
}

test('products resolve through the box channel index with plain downloads only', async () => {
  const { f, archive, files } = notesRelease();
  const host = fakeReleaseHost(files);
  const answer = spineIndex(youeye, 'dev', { notes: { repository: notesRepo, tag: f.tag, version: '0.6.1-dev.2', raw: f.raw } });
  const index = () => readChannelIndex({ getReleaseIndex: async () => answer });
  const box = await index();
  assert.equal(box.repository, youeye);
  assert.equal(box.channel, 'dev');

  const selected = (await resolveChannelProduct('notes', { index, fetch: host.fetch }))!;
  assert.equal(selected.repository, notesRepo);
  assert.equal(selected.release.tag, 'v0.6.1-dev.2');
  assert.deepEqual(await downloadProductAsset(selected, 'standalone.tar', 1024, host.fetch), archive);
  assert.equal(await resolveChannelProduct('wiki', { index, fetch: host.fetch }), null, 'a product missing from the index is not on this channel yet');
  assert.ok(host.requests.every((url) => url.includes('/releases/download/')), host.requests.join('\n'));

  // The document must match the index digest exactly.
  const tampered = spineIndex(youeye, 'dev', { notes: { repository: notesRepo, tag: f.tag, version: '0.6.1-dev.2', raw: Buffer.from('other') } });
  await assert.rejects(resolveChannelProduct('notes', { index: () => readChannelIndex({ getReleaseIndex: async () => tampered }), fetch: host.fetch }), /channel index digest/);
  await assert.rejects(resolveChannelProduct('youeye', { index, fetch: host.fetch }), /not a channel product/);
  // The entry's build must be the document's build manifest version.
  const wrongBuild = spineIndex(youeye, 'dev', { notes: { repository: notesRepo, tag: f.tag, version: '0.6.1-dev.2', build: '0.6.1-dev.3', raw: f.raw } });
  await assert.rejects(resolveChannelProduct('notes', { index: () => readChannelIndex({ getReleaseIndex: async () => wrongBuild }), fetch: host.fetch }), /channel index version/);
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
  // Redirects may not leave the release host (GitHub's asset CDN excepted).
  const redirecting = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/x' } })) as typeof fetch;
  await assert.rejects(downloadReleaseFile(`${notesRepo}/releases/download/v1.0.0/standalone.tar`, 1024, redirecting), /outside its release host/);
});

test('HTTP 403/429 is rate limiting with back-off, never a network failure', async () => {
  const url = `${notesRepo}/releases/download/v0.6.1-dev.2/product-release.json`;
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
  const entry = { repository: notesRepo, tag: 'v0.6.1-dev.2', version: '0.6.1-dev.2', build: '0.6.1-dev.2', document: 'product-release.json', sha256: 'a'.repeat(64) };
  assert.doesNotThrow(() => parseChannelIndex({ ...base, products: { notes: entry } }));
  assert.doesNotThrow(() => parseChannelIndex({ ...base, products: { youeye: { ...entry, repository: youeye, tag: 'youeye-v0.6.1-dev.2', document: 'core-release.json' }, market: { ...entry, tag: 'catalog-v0.6.1-dev.2' } } }));
  assert.throws(() => parseChannelIndex({ ...base, channel: 'feature' }), /Unsupported/);
  assert.throws(() => parseChannelIndex({ ...base, products: { canvas: entry } }), /fields/);
  assert.throws(() => parseChannelIndex({ ...base, products: { notes: { ...entry, tag: 'dev-v0.6.1-dev.2' } } }), /must name/);
  assert.throws(() => parseChannelIndex({ ...base, products: { notes: { ...entry, repository: `${notesRepo}/` } } }), /invalid/);
  assert.throws(() => parseChannelIndex({ ...base, products: { notes: { ...entry, url: 'x' } } }), /fields/);
  // `build` is required; a promoted entry names another release of the same build.
  const { build: _omitted, ...withoutBuild } = entry;
  assert.throws(() => parseChannelIndex({ ...base, products: { notes: withoutBuild } }), /invalid/);
  assert.throws(() => parseChannelIndex({ ...base, products: { notes: { ...entry, build: 'dev.2' } } }), /invalid/);
  assert.doesNotThrow(() => parseChannelIndex({ ...base, products: { notes: { ...entry, tag: 'v0.6.1', version: '0.6.1' } } }));
});
