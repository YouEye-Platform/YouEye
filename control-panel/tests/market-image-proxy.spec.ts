/**
 * GET /api/market/image needs no sign-in. It serves only pictures that an enabled, accepted market names, from the
 * box's copy of that market, and asks nothing of the network for any other request.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as format from '../src/lib/market/market-format';
import { MARKET_LIMITS, sha256Hex } from '../src/lib/market/market-format';
import { OFFICIAL_MARKET_ADDRESSES } from '../src/lib/market/source';
import { buildFixtureMarket } from './fixtures/market';
import { load, marketWorld, root, withMarketState } from './fixtures/market-world';

const OFFICIAL = OFFICIAL_MARKET_ADDRESSES.main;
const FRIEND = 'https://markets.example.org/friend/';
const STRANGER = 'https://markets.example.org/stranger/';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function assertInert(response: Response) {
  assert.equal(response.headers.get('content-security-policy'), SANDBOX);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

/** The official Market, an accepted custom market and one that is not accepted; each with its own pictures. */
async function scenario(directory: string) {
  const official = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha', pictures: { 'icon.svg': SVG, 'screenshots/a.png': PNG } }] });
  const friend = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'beta', pictures: { 'icon.svg': Buffer.from('<svg id="friend"/>') } }] });
  const stranger = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'gamma', pictures: { 'icon.svg': Buffer.from('<svg id="stranger"/>') } }] });
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true },
    { id: 'custom-1', name: 'Friend', url: FRIEND, enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' },
    { id: 'custom-2', name: 'Stranger', url: STRANGER, enabled: true, priority: 2 },
  ] }));
  const world = marketWorld({ [OFFICIAL]: official.files, [FRIEND]: friend.files, [STRANGER]: stranger.files });
  const route = load('src/app/api/market/image/route.ts', {
    '@/lib/market/market-format': format, '@/lib/market/market-store': world.store, '@/lib/market/source': world.sources,
  });
  const get = (query: string) => route.GET(new Request(`https://control.example.test/api/market/image${query}`)) as Promise<Response>;
  const picture = (source: string, file: string) => get(`?source=${encodeURIComponent(source)}&file=${encodeURIComponent(file)}`);
  // Each market is in the box's store, as after a listing.
  for (const source of await world.sources.getConfiguredMarketSources()) await world.store.refreshMarket(source);
  world.hosts.take();
  return { world, get, picture, official, friend, stranger };
}

test('a picture the accepted market names is served from the box\'s copy, typed by its extension and inert', withMarketState(async () => {
  const { world, picture, official, friend } = await scenario(process.env.YOUEYE_MARKET_STATE_DIR!);
  const icon = official.picturePaths.alpha['icon.svg'];
  const first = await picture('official', icon);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/svg+xml');
  assert.equal(first.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assertInert(first);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), SVG);
  assert.deepEqual(world.hosts.take(), [icon], 'fetched from the market on first use');

  const again = await picture('official', icon);
  assert.equal(again.status, 200);
  assert.equal(world.hosts.requests.length, 0, 'then from the store');
  const shot = await picture('official', official.picturePaths.alpha['screenshots/a.png']);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), PNG);
  // An accepted custom market's pictures are served the same way.
  const custom = await picture('custom-1', friend.picturePaths.beta['icon.svg']);
  assert.equal(custom.status, 200);
  assert.match(await custom.text(), /id="friend"/);
  assertInert(custom);
}));

test('simultaneous requests for one picture share one fetch', withMarketState(async () => {
  const { world, picture, official } = await scenario(process.env.YOUEYE_MARKET_STATE_DIR!);
  const icon = official.picturePaths.alpha['icon.svg'];
  const answers = await Promise.all(Array.from({ length: 8 }, () => picture('official', icon)));
  assert.ok(answers.every((answer) => answer.status === 200));
  assert.deepEqual(world.hosts.take(), [icon]);
}));

test('anything else is 404 and causes no outbound request', withMarketState(async (directory) => {
  const { world, get, picture, official, friend, stranger } = await scenario(directory);
  const icon = official.picturePaths.alpha['icon.svg'];
  const unnamed = `h/files/${sha256Hex('nobody names this')}.svg`;
  const queries = [
    '', '?source=official', `?file=${encodeURIComponent(icon)}`,
    // The forms this route had before: a URL to proxy, a catalog file.
    `?url=${encodeURIComponent('https://raw.githubusercontent.com/o/r/main/icon.svg')}`,
    `?url=${encodeURIComponent(`${OFFICIAL}${icon}`)}`, '?catalog=apps%2Falpha%2Ficon.svg', `?source=official&url=${encodeURIComponent(`${OFFICIAL}${icon}`)}`,
  ];
  for (const query of queries) {
    const response = await get(query);
    assert.equal(response.status, 404, query);
    assertInert(response);
    assert.equal(await response.text(), '');
  }
  const refusals: Array<[string, string, string]> = [
    ['official', unnamed, 'a well-formed path no index or bundle names'],
    ['official', 'market.json', 'the pointer'], ['official', official.indexPath, 'the index'], ['official', official.bundlePaths.alpha, 'a bundle'],
    ['official', '../state.json', 'a path out of the store'], ['official', `h/files/../../state.json`, 'a path out of the store'],
    ['official', `${icon}/../x.svg`, 'dot segments'], ['official', `h/files/${'A'.repeat(64)}.svg`, 'not a hash'],
    ['official', icon.replace('.svg', '.html'), 'another extension'], ['official', `${OFFICIAL}${icon}`, 'a URL'],
    ['official', friend.picturePaths.beta['icon.svg'], 'another source\'s picture'],
    ['custom-1', icon, 'the official Market\'s picture through another source'],
    ['custom-2', stranger.picturePaths.gamma['icon.svg'], 'a custom market the owner has not accepted'],
    ['custom-9', icon, 'a source that does not exist'], ['direct:abc', icon, 'an app added by URL'], ['../official', icon, 'not a source id'],
  ];
  for (const [source, file, why] of refusals) {
    const response = await picture(source, file);
    assert.equal(response.status, 404, why);
    assertInert(response);
  }
  // A market that is turned off serves nothing, even what it served before.
  assert.equal((await picture('custom-1', friend.picturePaths.beta['icon.svg'])).status, 200);
  world.hosts.take();
  const list = await world.sources.getConfiguredMarketSources();
  await world.sources.updateMarketSourceList(list.map((source: any) => ({ ...source, enabled: source.id === 'custom-2' })));
  assert.equal((await picture('custom-1', friend.picturePaths.beta['icon.svg'])).status, 404, 'a disabled custom market');
  assert.equal((await picture('official', icon)).status, 404, 'the official Market turned off');
  assert.equal(world.hosts.requests.length, 0, 'not one outbound request for any of these');
}));

test('with nothing in the store, the image route does not make the box read a market', withMarketState(async () => {
  const official = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha', pictures: { 'icon.svg': SVG } }] });
  const world = marketWorld({ [OFFICIAL]: official.files });
  const route = load('src/app/api/market/image/route.ts', {
    '@/lib/market/market-format': format, '@/lib/market/market-store': world.store, '@/lib/market/source': world.sources,
  });
  const response = await route.GET(new Request(`https://control.example.test/api/market/image?source=official&file=${encodeURIComponent(official.picturePaths.alpha['icon.svg'])}`));
  assert.equal(response.status, 404);
  assert.equal(world.hosts.requests.length, 0);
}));

test('a picture that is not what its path\'s hash says, or is over 5 MiB, is not served', withMarketState(async (directory) => {
  const { world, picture, official } = await scenario(directory);
  const icon = official.picturePaths.alpha['icon.svg'];
  world.hosts.state.replace[OFFICIAL + icon] = Buffer.from('<html><script>alert(document.domain)</script></html>');
  const wrong = await picture('official', icon);
  assert.equal(wrong.status, 502);
  assertInert(wrong);
  assert.equal(wrong.headers.get('cache-control'), 'no-store');
  assert.equal(await wrong.text(), '');
  assert.equal(existsSync(path.join(directory, 'markets/official', icon)), false, 'nothing is kept');
  // The failure is remembered: an anonymous visitor cannot make the box ask again and again.
  for (let n = 0; n < 5; n += 1) assert.equal((await picture('official', icon)).status, 502);
  assert.deepEqual(world.hosts.take(), [icon]);

  const big = Buffer.alloc(MARKET_LIMITS.file + 1, 7);
  const large = buildFixtureMarket({ sequence: 1795000100, apps: [{ id: 'alpha', pictures: { 'screenshots/big.png': big } }] });
  world.sites[OFFICIAL] = large.files;
  await world.store.refreshMarket((await world.sources.getConfiguredMarketSources())[0]);
  world.hosts.take();
  assert.equal((await picture('official', large.picturePaths.alpha['screenshots/big.png'])).status, 502);
  assert.equal(world.hosts.requests.length, 1);
}));

test('the route has no URL proxy left, and the dashboard\'s mirror of it is gone', () => {
  const route = readFileSync(path.join(root, 'src/app/api/market/image/route.ts'), 'utf8');
  assert.doesNotMatch(route, /ALLOWED_DOMAINS|searchParams\.get\('url'\)|searchParams\.get\('catalog'\)|releaseCacheFetch|\bfetch\(/);
  assert.doesNotMatch(route, /githubusercontent|jsdelivr|catalog\.youeye\.me/);
  assert.equal(existsSync(path.join(root, '..', 'ui', 'src', 'app', 'api', 'market', 'image', 'route.ts')), false);
  assert.equal(existsSync(path.join(root, 'src', 'lib', 'market', 'catalog-release.ts')), false);
});

test('the proxy sandboxes the image route (its policy replaces the route\'s own) and keeps it public', () => {
  const source = readFileSync(path.join(root, 'src/proxy.ts'), 'utf8');
  const start = source.indexOf('function applySecurityHeaders');
  const branch = source.slice(start, source.indexOf("pathname === '/api/ping'", start));
  assert.match(branch, /pathname === '\/api\/market\/image'/);
  assert.match(branch, /default-src 'none'; style-src 'unsafe-inline'; sandbox/);
  assert.doesNotMatch(branch, /script-src/);
  assert.match(source, /'\/api\/market\/image',/);
});
