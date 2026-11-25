/**
 * The Market reader and its routes under markets that misbehave or overreach: an entry that carries another app's
 * bundle, a custom market that lists YouEye's own apps, a market that never finishes answering, a store that cannot
 * be shown, an official lane offered as a custom market, pictures asked for all at once, a slow host of an app
 * added by URL.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as format from '../src/lib/market/market-format';
import { MARKET_POINTER_FILE, sha256Hex } from '../src/lib/market/market-format';
import { OFFICIAL_MARKET_ADDRESSES, OFFICIAL_MARKET_AS_CUSTOM } from '../src/lib/market/source';
import { URL_APP_DEADLINE_MS, URL_APP_FILE_DEADLINE_MS, UrlAppError, fetchUrlApp, type PinnedGet } from '../src/lib/market/url-app';
import { appYAML, nativeFixture } from './fixtures/app-format';
import { buildFixtureMarket } from './fixtures/market';
import { load, marketWorld, withMarketState, type WorldOptions } from './fixtures/market-world';

const nodeRequire = createRequire(import.meta.url);
const OFFICIAL = OFFICIAL_MARKET_ADDRESSES.main;
const DEV = OFFICIAL_MARKET_ADDRESSES.dev;
const FRIEND = 'https://markets.example.org/friend/';
const SLOW = 'https://markets.example.org/slow/';
const ACCEPTED_AT = '2026-11-18T10:00:00.000Z';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const session = async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } });
const admin = { requireAdmin: session, requireAdminCsrf: session };
const post = (body: unknown) => new Request('https://cp.example.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function seed(directory: string, entries: Array<Record<string, unknown>>) {
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [{ id: 'official', enabled: true }, ...entries] }));
}
const friendEntry = { id: 'custom-1', name: 'Friend', url: FRIEND, enabled: true, priority: 1, accepted_at: ACCEPTED_AT };

function routesOf(sites: Record<string, Map<string, Buffer>>, options: WorldOptions = {}) {
  const world = marketWorld(sites, options);
  const mocks = {
    'next/server': { NextResponse: { json } }, '@/lib/auth/rbac': admin, '@/lib/market/source': world.sources,
    '@/lib/market/market-store': world.store, '@/lib/market/catalog': { clearCatalogCache() {} },
  };
  const route = load('src/app/api/market/source/route.ts', mocks);
  const refresh = load('src/app/api/market/source/refresh/route.ts', mocks);
  const image = load('src/app/api/market/image/route.ts', { '@/lib/market/market-format': format, '@/lib/market/market-store': world.store, '@/lib/market/source': world.sources });
  const patch = (body: unknown) => route.PATCH(new Request('https://cp.example.test/api', { method: 'PATCH', body: JSON.stringify(body) })) as Promise<Response>;
  const picture = (source: string, file: string) =>
    image.GET(new Request(`https://cp.example.test/api/market/image?source=${encodeURIComponent(source)}&file=${encodeURIComponent(file)}`)) as Promise<Response>;
  return { world, route, refresh, patch, picture };
}

// ─── E: an entry is the app its bundle holds ──────────────

test('an entry that carries another app\'s bundle never resolves to that app, compiled before or not', withMarketState(async () => {
  const honest = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'foo' }] });
  // `bar` is listed with the very bytes of foo's bundle (the path says bar, the hash is right).
  const built = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'foo' }, { id: 'bar', bundle: { manifest: honest.manifests.foo, setups: {}, files: {} } }] });
  assert.equal(built.bundlePaths.bar.split('/').pop(), built.bundlePaths.foo.split('/').pop(), 'the same bundle bytes under two ids');
  const world = marketWorld({ [OFFICIAL]: built.files });

  for (let read = 1; read <= 3; read += 1) {
    const warnings: Array<{ itemId?: string; message: string }> = [];
    const apps = await world.catalog.fetchAvailableApps((warning: { itemId?: string; message: string }) => warnings.push(warning));
    assert.deepEqual(apps.map((app: any) => app.id), ['foo'], `listing ${read}: foo once, bar not at all`);
    assert.deepEqual(warnings.map((warning) => warning.itemId), ['bar']);
    assert.match(warnings[0].message, /bar could not be loaded: its bundle holds app "foo"/);
  }
  // In either order, and however often: foo is foo, bar is refused.
  assert.equal((await world.catalog.resolveCatalogApp('foo')).manifest.metadata.id, 'foo');
  for (let read = 1; read <= 2; read += 1) {
    await assert.rejects(world.catalog.resolveCatalogApp('bar'), /App "bar" could not be resolved .*its bundle holds app "foo"/);
    await assert.rejects(world.catalog.fetchManifest('bar'), /its bundle holds app "foo"/);
  }
  assert.equal((await world.catalog.fetchManifest('foo')).metadata.id, 'foo');
}));

// ─── H: native apps come from any market (YE-142) ─────────

test('a `native` id list is ignored; native apps are index entries, and a custom market may offer them as it offers any app', withMarketState(async (directory) => {
  seed(directory, [friendEntry]);
  const official = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }, { id: 'notes', native: true, version: '0.6.4' }], legacyNative: ['wiki'] });
  // A custom market with its own native app, a copy of the official Notes, and an old-style native id list.
  const copy = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }, { id: 'beta' }, { id: 'notes', native: true, version: '0.6.4' }, { id: 'journal', native: true }],
    legacyNative: ['wiki'], bundles: [{ id: 'pair', members: ['journal', 'beta'] }] });
  const world = marketWorld({ [OFFICIAL]: official.files, [FRIEND]: copy.files }, { boxVersion: '0.6.20' });

  const warnings: unknown[] = [];
  const apps = await world.catalog.fetchAvailableApps((warning: unknown) => warnings.push(warning));
  assert.deepEqual(apps.map((app: any) => `${app.sourceId}/${app.id}/${app.integration}`).sort(),
    ['custom-1/alpha/basic', 'custom-1/beta/basic', 'custom-1/journal/native', 'custom-1/notes/native', 'official/alpha/basic', 'official/notes/native']);
  assert.deepEqual(warnings, []);

  // Each resolves from its own source only; the old `native` list names nothing installable.
  assert.equal((await world.catalog.resolveCatalogApp('journal', 'custom-1')).entry.integration, 'native');
  assert.equal((await world.catalog.resolveCatalogApp('notes', 'custom-1')).source.id, 'custom-1');
  assert.equal((await world.catalog.resolveCatalogApp('notes')).source.id, 'official');
  await assert.rejects(world.catalog.resolveCatalogApp('wiki', 'custom-1'), /app is not present/);
  await assert.rejects(world.catalog.resolveCatalogApp('wiki'), /app is not present/);
  await assert.rejects(world.catalog.resolveCatalogApp('journal'), /app is not present/, 'the official Market never resolves another market\'s app');

  const sources = await world.sources.getConfiguredMarketSources();
  const customSource = sources.find((source: any) => source.id === 'custom-1');
  assert.deepEqual((await world.catalog.fetchCatalog(customSource)).apps.map((app: any) => [app.id, app.integration]),
    [['alpha', 'basic'], ['beta', 'basic'], ['journal', 'native'], ['notes', 'native']]);
  const pair = await world.catalog.fetchBundle('pair', 'custom-1');
  assert.equal((await world.catalog.resolveCatalogApp(pair.members[0], pair.sourceId)).entry.integration, 'native');

  // What the sources page and the add-preview say a market holds counts its native entries, any market's.
  assert.equal((await world.store.marketSourceView(customSource)).market.native, 2);
  assert.equal((await world.store.marketSourceView(sources.find((source: any) => source.id === 'official'))).market.native, 1);
  world.sites['https://markets.example.org/other/'] = copy.files;
  const preview = await world.store.previewMarket('https://markets.example.org/other/');
  assert.deepEqual([preview.apps, preview.native], [4, 2]);
}));

// ─── B: one slow market does not hold the others' listing ─

test('a market that never finishes answering delays a listing by the reader\'s wait at most, and only once', withMarketState(async (directory) => {
  seed(directory, [{ id: 'custom-1', name: 'Slow', url: SLOW, enabled: true, priority: 1, accepted_at: ACCEPTED_AT }]);
  const official = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }], bundles: [{ id: 'pair', members: ['alpha'] }] });
  const slow = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'beta' }] });
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  const world = marketWorld({ [OFFICIAL]: official.files, [SLOW]: slow.files },
    { hosts: { before: (url) => (url.startsWith(SLOW) && /h\/apps\//.test(url) ? held : undefined) }, store: { readerWaitMs: 150, refreshDeadlineMs: 5000 } });

  const warnings: Array<{ sourceId?: string; message: string }> = [];
  const started = Date.now();
  const apps = await world.catalog.fetchAvailableApps((warning: { sourceId?: string; message: string }) => warnings.push(warning));
  const first = Date.now() - started;
  assert.deepEqual(apps.map((app: any) => `${app.sourceId}/${app.id}`), ['official/alpha'], 'the other market is listed');
  assert.ok(first < 1000, `the listing took ${first} ms`);
  assert.deepEqual(warnings.map((warning) => warning.sourceId), ['custom-1']);
  assert.match(warnings[0].message, /Slow: could not load its catalog: The market is still being read/);

  // Everything else a Market page reads, while the slow market is still held open: no further wait.
  const again = Date.now();
  await world.catalog.fetchAvailableApps();
  assert.deepEqual((await world.catalog.fetchCategories()).map((category: any) => category.id), ['utilities']);
  assert.deepEqual((await world.catalog.fetchBundles()).map((bundle: any) => bundle.id), ['pair']);
  await world.catalog.fetchCuration();
  assert.equal((await world.catalog.resolveCatalogApp('alpha')).source.id, 'official');
  assert.ok(Date.now() - again < 120, `the next reads took ${Date.now() - again} ms`);

  // The slow market was not given up: once it answers, it is listed.
  open();
  await pause(60);
  assert.deepEqual((await world.catalog.fetchAvailableApps()).map((app: any) => `${app.sourceId}/${app.id}`).sort(), ['custom-1/beta', 'official/alpha']);
}));

test('adding a market and "refresh now" answer within the reader\'s wait; the box reads on', withMarketState(async () => {
  const official = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }] });
  const slow = buildFixtureMarket({ sequence: 1795000000, commit: 'slow-one', apps: [{ id: 'beta' }] });
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  const { world, route, refresh } = routesOf({ [OFFICIAL]: official.files, [SLOW]: slow.files },
    { hosts: { before: (url) => (url.startsWith(SLOW) && /h\/apps\//.test(url) ? held : undefined) }, store: { readerWaitMs: 150, refreshDeadlineMs: 5000 } });

  const started = Date.now();
  const added = await route.POST(post({ url: SLOW, acceptRisk: true })) as Response;
  assert.equal(added.status, 200);
  assert.ok(Date.now() - started < 1000, `adding took ${Date.now() - started} ms`);
  const answer = await added.json();
  assert.equal(answer.source.id, 'custom-1');
  assert.equal(answer.source.market, null, 'its first copy is not there yet');

  const asked = Date.now();
  const refreshed = await (await refresh.POST(post({}))).json();
  assert.ok(Date.now() - asked < 1000, `refresh took ${Date.now() - asked} ms`);
  assert.deepEqual(refreshed.results.map((result: any) => [result.id, result.ok]), [['official', true], ['custom-1', false]]);
  assert.match(refreshed.results[1].error, /still being read; this box keeps reading it in the background/);

  open();
  await pause(60);
  const sources = (await (await route.GET()).json()).sources;
  assert.equal(sources.find((source: any) => source.id === 'custom-1').market.commit, 'slow-one');
  assert.equal(world.hosts.requests.filter((request) => request.address === SLOW && request.path === MARKET_POINTER_FILE).length, 2, 'the preview and one refresh');
}));

// ─── D: the list of sources never fails for one source ────

test('a store with a sequence that is no time does not take the source list, its edit or its removal away', withMarketState(async (directory) => {
  seed(directory, [friendEntry]);
  const official = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }] });
  const huge = buildFixtureMarket({ sequence: Number.MAX_SAFE_INTEGER, apps: [{ id: 'beta' }] });
  const { world, route, refresh, patch } = routesOf({ [OFFICIAL]: official.files, [FRIEND]: huge.files });
  // What a box accepted from that market before `sequence` was bounded.
  const store = path.join(directory, 'markets/custom-1');
  for (const [file, bytes] of huge.files) {
    if (file === MARKET_POINTER_FILE) continue;
    mkdirSync(path.dirname(path.join(store, file)), { recursive: true });
    writeFileSync(path.join(store, file), bytes);
  }
  writeFileSync(path.join(store, 'state.json'), JSON.stringify({
    schema: 'youeye.market-store.v1', address: FRIEND, sequence: Number.MAX_SAFE_INTEGER,
    pointer_base64: huge.pointer.toString('base64'), pointer_sha256: sha256Hex(huge.pointer), accepted_at: ACCEPTED_AT,
  }));

  const listed = await route.GET() as Response;
  assert.equal(listed.status, 200);
  const sources = (await listed.json()).sources;
  assert.deepEqual(sources.map((source: any) => source.id), ['official', 'custom-1']);
  assert.equal(sources[1].market, null);

  const refreshed = await refresh.POST(post({})) as Response;
  assert.equal(refreshed.status, 200);
  const results = (await refreshed.json()).results;
  assert.deepEqual(results.map((result: any) => [result.id, result.ok]), [['official', true], ['custom-1', false]]);
  assert.match(results[1].error, /market\.json: sequence: must be a time in seconds/);
  assert.deepEqual((await world.catalog.fetchAvailableApps()).map((app: any) => app.id), ['alpha'], 'the other market is listed');

  // The owner can turn it off, and remove it.
  const off = await patch({ active_sources: sources.map((source: any) => ({ ...source, enabled: source.id === 'official' })) });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).sources[1].enabled, false);
  const removed = await patch({ active_sources: sources.filter((source: any) => source.id === 'official') });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).sources.map((source: any) => source.id), ['official']);
  assert.equal(existsSync(store), false);
}));

// ─── F: the official lanes are not custom markets ─────────

test('an official lane cannot be added as a custom market or be the new address of one; test markets of the same host can', withMarketState(async (directory) => {
  seed(directory, [friendEntry]);
  const built = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }] });
  const test = 'https://market.youeye.me/test/andrew/';
  const { world, route, patch } = routesOf({ [OFFICIAL]: built.files, [DEV]: built.files, [FRIEND]: built.files, [test]: built.files }, { lane: 'dev' });
  const ids = async () => (await world.sources.getConfiguredMarketSources()).map((source: any) => source.id);

  for (const url of [OFFICIAL, DEV, 'https://market.youeye.me', 'https://market.youeye.me/market.json', 'https://market.youeye.me/dev', 'https://MARKET.youeye.me/dev/market.json', 'https://market.youeye.me./', 'https://market.youeye.me:443/dev/']) {
    const answer = await route.POST(post({ url, acceptRisk: true })) as Response;
    assert.equal(answer.status, 400, url);
    assert.deepEqual(await answer.json(), { error: 'This is the official YouEye Market; your YouEye already follows it' }, url);
  }
  assert.equal(world.hosts.requests.length, 0, 'nothing is fetched for a refused address');
  assert.deepEqual(await ids(), ['official', 'custom-1']);
  // The library call itself refuses too (the CLI and the add page go through the route; nothing else may add one).
  await assert.rejects(world.sources.addMarketSource({ url: DEV }), (error: Error) => error.message === OFFICIAL_MARKET_AS_CUSTOM);

  // An existing custom market cannot be re-pointed at a lane.
  const list = await world.sources.getConfiguredMarketSources();
  for (const url of [OFFICIAL, DEV]) {
    const moved = await patch({ active_sources: list.map((source: any) => (source.id === 'custom-1' ? { ...source, url } : source)) });
    assert.equal(moved.status, 400, url);
    assert.equal((await moved.json()).error, OFFICIAL_MARKET_AS_CUSTOM);
  }
  assert.equal((await world.sources.getConfiguredMarketSources()).find((source: any) => source.id === 'custom-1').url, FRIEND);

  // The preview says the same for the lane this box (set to dev) does not follow, with a typed refusal…
  await assert.rejects(world.store.previewMarket(OFFICIAL), (error: any) => error.name === 'MarketRefreshError' && error.code === 'official-market'
    && error.message === OFFICIAL_MARKET_AS_CUSTOM && world.store.isOfficialMarketRefusal(error));
  assert.equal(world.hosts.requests.length, 0);
  // …and reads the lane it follows, which is the official source already.
  assert.equal((await world.store.previewMarket(DEV)).address, DEV);
  await assert.rejects(world.store.previewMarket('https://markets.example.org/nothing/'), (error: any) => error.name === 'MarketRefreshError' && !world.store.isOfficialMarketRefusal(error));

  // A test market below the same host is an ordinary market.
  const added = await route.POST(post({ url: test, acceptRisk: true })) as Response;
  assert.equal(added.status, 200);
  assert.equal((await added.json()).source.url, test);
  assert.deepEqual(await ids(), ['official', 'custom-1', 'custom-2']);

  // The lane is the box's own setting (YE-142): PATCH { official_lane }; nothing else of the list changes.
  const toMain = await patch({ official_lane: 'main' });
  assert.equal(toMain.status, 200);
  const listed = (await toMain.json()).sources;
  assert.deepEqual(listed.map((source: any) => [source.id, source.lane ?? null]), [['official', 'main'], ['custom-1', null], ['custom-2', null]]);
  assert.equal((await world.store.previewMarket(OFFICIAL)).address, OFFICIAL, 'main is now the lane this box follows');
  await assert.rejects(world.store.previewMarket(DEV), (error: any) => world.store.isOfficialMarketRefusal(error));
  for (const lane of ['stable', 'alpha', '', null, 'test/andrew']) {
    const refused = await patch({ official_lane: lane });
    assert.equal(refused.status, 400, String(lane));
    assert.match((await refused.json()).error, /The official Market lane is main or dev/);
  }
  assert.equal((await world.sources.getConfiguredMarketSources())[0].lane, 'main');
}));

// ─── G: the image route under many requests ───────────────

test('requests for many pictures the box does not hold yet: four fetches at a time, then 503 with Retry-After; nothing else changes', withMarketState(async (directory) => {
  seed(directory, [friendEntry]);
  const picture = (n: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" id="p${n}"/>`);
  const official = buildFixtureMarket({ sequence: 1795000000, apps: Array.from({ length: 5 }, (_, n) => ({ id: `a${n}`, pictures: { 'icon.svg': picture(n) } })) });
  const friend = buildFixtureMarket({ sequence: 1795000000, apps: Array.from({ length: 3 }, (_, n) => ({ id: `b${n}`, pictures: { 'icon.svg': picture(100 + n) } })) });
  let hold = false;
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  const { world, picture: get } = routesOf({ [OFFICIAL]: official.files, [FRIEND]: friend.files },
    { hosts: { before: (url) => (hold && /h\/files\//.test(url) ? held : undefined) }, store: { pictureWaitMs: 120 } });
  for (const source of await world.sources.getConfiguredMarketSources()) await world.store.refreshMarket(source);
  const icons = Array.from({ length: 5 }, (_, n) => official.picturePaths[`a${n}`]['icon.svg']);
  const friends = Array.from({ length: 3 }, (_, n) => friend.picturePaths[`b${n}`]['icon.svg']);
  // One picture is on the box already.
  assert.equal((await get('official', icons[4])).status, 200);
  world.hosts.take();

  hold = true;
  const first = [get('official', icons[0]), get('official', icons[1]), get('official', icons[2]), get('custom-1', friends[0])];
  await pause(30);
  assert.equal(world.hosts.requests.length, 4);
  // Beyond the limit: no fetch; the answer is 503, inert, not cached, with Retry-After.
  const turnedAway = [get('official', icons[3]), get('custom-1', friends[1]), get('custom-1', friends[2])];
  await pause(30);
  assert.equal(world.hosts.requests.length, 4, 'not one more request went out');
  const busy = await Promise.all(turnedAway);
  assert.equal(world.hosts.requests.length, 4);
  for (const answer of busy) {
    assert.equal(answer.status, 503);
    assert.equal(answer.headers.get('retry-after'), '5');
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.equal(answer.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await answer.text(), '');
  }
  // What the box holds, and what it must not serve, is answered as ever while it is busy.
  assert.equal((await get('official', icons[4])).status, 200);
  assert.equal((await get('official', `h/files/${sha256Hex('nobody names this')}.svg`)).status, 404);
  assert.equal((await get('custom-9', icons[0])).status, 404);

  hold = false;
  open();
  assert.deepEqual((await Promise.all(first)).map((answer) => answer.status), [200, 200, 200, 200]);
  // "Busy" was not remembered: the pictures that were turned away are served now.
  const later = await get('official', icons[3]);
  assert.equal(later.status, 200);
  assert.equal(later.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await later.text(), /id="p3"/);
  assert.equal((await get('custom-1', friends[1])).status, 200);
}));

// ─── B: an app added by URL has deadlines too ─────────────

test('an app added by URL: each file has a deadline, and so has the whole app', async () => {
  assert.equal(URL_APP_FILE_DEADLINE_MS, 20_000);
  assert.equal(URL_APP_DEADLINE_MS, 60_000);
  const manifest = appYAML({ id: 'demo' });
  const setup = 'schema: youeye.setup.v1\nfor: install\nsteps:\n  - wait: { http: /health }\n';
  const deadlines: Array<[string, number | undefined]> = [];
  const serve: PinnedGet = async (url, _pinned, deadlineMs) => {
    deadlines.push([url.pathname, deadlineMs]);
    if (url.pathname.endsWith('youeye-app.yaml')) return { status: 200, contentType: 'text/yaml', body: manifest };
    return url.pathname.endsWith('/setup/install.yaml') ? { status: 200, contentType: 'text/yaml', body: setup } : { status: 404, contentType: 'text/plain', body: '' };
  };
  const resolve = async () => ['93.184.216.34'];
  await fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', { resolve, get: serve });
  assert.equal(deadlines[0][0], '/demo/youeye-app.yaml');
  assert.ok(deadlines.length > 1 && deadlines.some(([file]) => file === '/demo/setup/install.yaml'), 'the setup files are asked for');
  assert.ok(deadlines.every(([, ms]) => typeof ms === 'number' && ms > 0 && ms <= URL_APP_FILE_DEADLINE_MS), 'every request carries a deadline');

  // A host that never finishes a file: the fetch ends at the file's deadline whatever the transport does.
  const never: PinnedGet = () => new Promise(() => {});
  let started = Date.now();
  await assert.rejects(fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', { resolve, get: never, fileDeadlineMs: 80 }),
    (error: unknown) => error instanceof UrlAppError && /could not be read in time/.test(error.message));
  assert.ok(Date.now() - started < 1000);
  // A resolver that never answers is no way around it.
  await assert.rejects(fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', { resolve: () => new Promise(() => {}), get: serve, fileDeadlineMs: 80 }), /could not be read in time/);

  // A host that serves the manifest and then drips its setup files: the whole app has a deadline as well.
  const calls: number[] = [];
  const drip: PinnedGet = async (url, _pinned, deadlineMs) => {
    calls.push(deadlineMs ?? -1);
    if (url.pathname.endsWith('youeye-app.yaml')) { await pause(120); return { status: 200, contentType: 'text/yaml', body: manifest }; }
    return new Promise(() => {});
  };
  started = Date.now();
  await assert.rejects(fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', { resolve, get: drip, fileDeadlineMs: 5000, deadlineMs: 250 }), /could not be read in time/);
  assert.ok(Date.now() - started < 1000, `the app ended after ${Date.now() - started} ms`);
  assert.ok(calls[1] > 0 && calls[1] <= 140, `the setup file got what was left of the app's time (${calls[1]} ms)`);
});

test('the transport of an app added by URL is given the deadline: a body that never ends is cut off', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  class SilentRequest extends EventEmitter {
    destroyed = false;
    destroy(error?: Error) {
      if (this.destroyed) return this;
      this.destroyed = true;
      if (error) queueMicrotask(() => this.emit('error', error));
      return this;
    }
    setTimeout() { return this; }   // the idle timer never fires: the body keeps trickling
    end() { return this; }
  }
  const requests: SilentRequest[] = [];
  const urlApp = load('src/lib/market/url-app.ts', {
    'node:https': { request: () => { const request = new SilentRequest(); requests.push(request); return request; } },
    'node:net': nodeRequire('node:net'),
    'node:dns/promises': { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
    './constants': { CONTAINER_DOMAIN: 'youeye' }, './app-format/compile': { fetchApp: async () => ({}) }, './app-format/parse': { MAX_DOCUMENT_BYTES: 1024 * 1024 },
  });
  let outcome = 'pending';
  urlApp.fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml').then(() => { outcome = 'fetched'; }, (error: Error) => { outcome = error.message; });
  const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  await settle();
  assert.equal(requests.length, 1);
  context.mock.timers.tick(URL_APP_FILE_DEADLINE_MS - 1);
  await settle();
  assert.equal(outcome, 'pending');
  context.mock.timers.tick(1);
  await settle();
  assert.equal(requests[0].destroyed, true, 'the request is ended');
  assert.match(outcome, /Request timed out|could not be read in time/);
});
