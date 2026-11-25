/**
 * The box's copy of a market (src/lib/market/market-store.ts) and the fetcher behind it: what is accepted, what is
 * refused, what a refresh costs, and when a market is asked at all.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MARKET_LIMITS, MARKET_POINTER_FILE, sha256Hex } from '../src/lib/market/market-format';
import { MarketFetchError, openMarketSession } from '../src/lib/market/market-fetch';
import {
  MARKET_REFRESH_INTERVAL_MS, MarketRefreshError, currentMarket, marketRefreshWait, marketStoreDirectory, previewMarket,
  readAcceptedMarket, readMarketPicture, readMarketRefreshStatus, refreshMarket, requestMarketRefresh, resetMarketStoreMemory,
} from '../src/lib/market/market-store';
import {
  OFFICIAL_MARKET_ADDRESSES, customMarketSource, getConfiguredMarketSources, officialMarketAddress, officialMarketSource, setOfficialMarketLane,
} from '../src/lib/market/source';
import { buildFixtureMarket, fakeMarketHosts, type FixtureMarket } from './fixtures/market';

const ADDRESS = 'https://markets.example.org/friend/';
const custom = customMarketSource(ADDRESS, { id: 'custom-1', name: 'Friend', accepted_at: '2026-11-18T10:00:00.000Z' });
const official = officialMarketSource();
const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const SHOT = Buffer.from('not really a webp, but bytes with a hash');

const one = (overrides: Partial<FixtureMarket> = {}): FixtureMarket => ({
  sequence: 1795000000, commit: 'aaaa1111',
  apps: [
    { id: 'alpha', pictures: { 'icon.svg': ICON, 'screenshots/a.webp': SHOT } },
    { id: 'beta', setups: { 'install.yaml': 'schema: youeye.setup.v1\nfor: install\nsteps:\n  - wait: { http: /health }\n' } },
    { id: 'gamma' },
  ],
  bundles: [{ id: 'pair', members: ['alpha', 'beta'] }],
  ...overrides,
});

/** A temporary /var/lib/youeye and a clean memory for each test. */
function withStore(work: (directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'youeye-market-store-'));
    const previous = process.env.YOUEYE_MARKET_STATE_DIR;
    process.env.YOUEYE_MARKET_STATE_DIR = directory;
    resetMarketStoreMemory();
    try { await work(directory); }
    finally {
      if (previous === undefined) delete process.env.YOUEYE_MARKET_STATE_DIR; else process.env.YOUEYE_MARKET_STATE_DIR = previous;
      resetMarketStoreMemory();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const refused = (pattern: RegExp) => (error: unknown) => error instanceof MarketRefreshError && pattern.test(error.message);
const hashedFiles = (directory: string, area: string): string[] => {
  const root = path.join(directory, 'markets', 'custom-1', 'h', area);
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[]).filter((name) => /\.[a-z]+$/.test(name)).sort();
};

// ─── Accepting ────────────────────────────────────────────

test('a market is accepted file by file: pointer, index, every bundle; then nothing is fetched until it changes', withStore(async (directory) => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  const accepted = await refreshMarket(custom, { deps: hosts.deps });
  assert.deepEqual(hosts.take(), [MARKET_POINTER_FILE, built.indexPath, ...Object.values(built.bundlePaths)], 'pointer, index, then the three bundles');
  assert.equal(accepted.address, ADDRESS);
  assert.equal(accepted.pointer.sequence, 1795000000);
  assert.deepEqual(accepted.index.apps.map((app) => app.id), ['alpha', 'beta', 'gamma']);
  assert.deepEqual([...accepted.bundles.keys()], ['alpha', 'beta', 'gamma']);
  assert.ok([...accepted.bundles.values()].every((bundle) => bundle.ok));
  assert.deepEqual([...accepted.pictures].sort(), Object.values(built.picturePaths.alpha).sort(), 'index icons and bundle pictures are named');
  assert.deepEqual(accepted.damaged, []);
  // The store holds the pointer's exact bytes, the index and every bundle; no picture yet.
  const state = JSON.parse(readFileSync(path.join(directory, 'markets/custom-1/state.json'), 'utf8'));
  assert.equal(state.address, ADDRESS);
  assert.equal(state.sequence, 1795000000);
  assert.deepEqual(Buffer.from(state.pointer_base64, 'base64'), built.pointer);
  assert.equal(hashedFiles(directory, 'apps').length, 3);
  assert.equal(hashedFiles(directory, 'index').length, 1);
  assert.deepEqual(hashedFiles(directory, 'files'), []);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'markets/custom-1/refresh.json'), 'utf8')).error, undefined);

  // The second refresh sends the ETag and gets 304: one request, nothing changes on disk.
  const before = readFileSync(path.join(directory, 'markets/custom-1/state.json'));
  const again = await refreshMarket(custom, { deps: hosts.deps });
  assert.deepEqual(hosts.requests.map((request) => [request.path, request.status, typeof request.ifNoneMatch]), [[MARKET_POINTER_FILE, 304, 'string']]);
  assert.deepEqual(readFileSync(path.join(directory, 'markets/custom-1/state.json')), before);
  assert.equal(again.pointerSHA256, accepted.pointerSHA256);
}));

test('a changed app costs the pointer, the index and exactly one bundle; what the index no longer names is removed', withStore(async (directory) => {
  const first = buildFixtureMarket(one());
  const sites = { [ADDRESS]: first.files };
  const hosts = fakeMarketHosts(sites);
  await refreshMarket(custom, { deps: hosts.deps });
  hosts.take();

  const second = buildFixtureMarket(one({ sequence: 1795000100, commit: 'bbbb2222',
    apps: [{ id: 'alpha', pictures: { 'icon.svg': ICON, 'screenshots/a.webp': SHOT } }, { id: 'beta', version: '1.1.0' }] }));
  sites[ADDRESS] = second.files;
  const accepted = await refreshMarket(custom, { deps: hosts.deps });
  assert.deepEqual(hosts.take(), [MARKET_POINTER_FILE, second.indexPath, second.bundlePaths.beta]);
  assert.equal(accepted.pointer.commit, 'bbbb2222');
  assert.deepEqual(accepted.index.apps.map((app) => [app.id, app.version]), [['alpha', '1.0.0'], ['beta', '1.1.0']]);
  // gamma's bundle, beta's old bundle and the old index are gone.
  assert.deepEqual(hashedFiles(directory, 'apps'), [second.bundlePaths.alpha, second.bundlePaths.beta].map((file) => file.slice('h/apps/'.length)).sort());
  assert.deepEqual(hashedFiles(directory, 'index'), [second.indexPath.slice('h/index/'.length)]);
}));

test('a file that is not what its hash names is refused at every level, and the accepted state stays', withStore(async () => {
  const first = buildFixtureMarket(one());
  const second = buildFixtureMarket(one({ sequence: 1795000100, apps: [{ id: 'alpha', version: '2.0.0' }, { id: 'beta' }, { id: 'gamma' }] }));
  const sites = { [ADDRESS]: first.files };
  const hosts = fakeMarketHosts(sites);
  await refreshMarket(custom, { deps: hosts.deps });
  sites[ADDRESS] = second.files;

  // pointer → index
  hosts.state.replace[ADDRESS + second.indexPath] = Buffer.from(second.files.get(second.indexPath)!.toString('utf8').replace('alpha', 'alphb'));
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/The index is not the file its hash names/));
  // same size, other bytes
  assert.equal((await readAcceptedMarket(custom))!.pointer.sequence, 1795000000);
  delete hosts.state.replace[ADDRESS + second.indexPath];

  // index → bundle
  hosts.state.replace[ADDRESS + second.bundlePaths.alpha] = Buffer.from(second.files.get(second.bundlePaths.alpha)!.toString('utf8').replace('2.0.0', '6.6.6'));
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/The bundle of alpha is not the file its hash names/));
  const kept = (await readAcceptedMarket(custom))!;
  assert.equal(kept.pointer.sequence, 1795000000, 'the pointer is committed last: a failed accept changes nothing');
  assert.equal(kept.index.apps[0].version, '1.0.0');
  assert.match((await readMarketRefreshStatus('custom-1')).error!, /bundle of alpha/);
  delete hosts.state.replace[ADDRESS + second.bundlePaths.alpha];

  // A pointer that is not a pointer.
  hosts.state.replace[ADDRESS + MARKET_POINTER_FILE] = Buffer.from('<html>not a market</html>');
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/market\.json is not JSON/));
  hosts.state.replace[ADDRESS + MARKET_POINTER_FILE] = Buffer.from(JSON.stringify({ ...JSON.parse(second.pointer.toString('utf8')), index: { path: 'h/index/../../etc/passwd', sha256: 'a'.repeat(64), size: 10 } }));
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/market\.json: index\.path/));
  delete hosts.state.replace[ADDRESS + MARKET_POINTER_FILE];

  // Whole again: accepted, and the error is cleared.
  assert.equal((await refreshMarket(custom, { deps: hosts.deps })).pointer.sequence, 1795000100);
  assert.equal((await readMarketRefreshStatus('custom-1')).error, undefined);
}));

test('a lower sequence is refused for the same address and accepted after the address changed', withStore(async (directory) => {
  const newer = buildFixtureMarket(one({ sequence: 1795000500, commit: 'new' }));
  const older = buildFixtureMarket(one({ sequence: 1795000100, commit: 'old', apps: [{ id: 'alpha' }] }));
  const sites: Record<string, Map<string, Buffer>> = { [ADDRESS]: newer.files };
  const hosts = fakeMarketHosts(sites);
  await refreshMarket(custom, { deps: hosts.deps });

  // The market went back to an older commit: refused, state kept, reason recorded.
  sites[ADDRESS] = older.files;
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/sequence 1795000100, lower than the 1795000500 this box accepted/));
  assert.equal((await readAcceptedMarket(custom))!.pointer.commit, 'new');
  // The same sequence with other content is not lower.
  const same = buildFixtureMarket(one({ sequence: 1795000500, commit: 'rebuilt', apps: [{ id: 'alpha' }, { id: 'beta' }] }));
  sites[ADDRESS] = same.files;
  assert.equal((await refreshMarket(custom, { deps: hosts.deps })).pointer.commit, 'rebuilt');

  // The source now points at another address: a new floor, and the store is replaced.
  const elsewhere = 'https://markets.example.org/other/';
  sites[elsewhere] = older.files;
  const moved = { ...custom, url: elsewhere };
  assert.equal(await readAcceptedMarket(moved), null, 'what was accepted from the old address is not this source\'s market any more');
  const accepted = await refreshMarket(moved, { deps: hosts.deps });
  assert.equal(accepted.address, elsewhere);
  assert.equal(accepted.pointer.sequence, 1795000100);
  assert.deepEqual(hashedFiles(directory, 'apps'), [older.bundlePaths.alpha.slice('h/apps/'.length)]);
  // …and the new address has its own floor.
  sites[elsewhere] = buildFixtureMarket(one({ sequence: 1795000050 })).files;
  await assert.rejects(refreshMarket(moved, { deps: hosts.deps }), refused(/lower than the 1795000100/));
}));

test('the official Market reads its lane, main by default: a lane change starts a new floor (YE-142)', withStore(async (directory) => {
  const dev = buildFixtureMarket(one({ sequence: 1795009999, commit: 'dev' }));
  const main = buildFixtureMarket(one({ sequence: 1795000001, commit: 'main', apps: [{ id: 'alpha' }] }));
  const hosts = fakeMarketHosts({ [OFFICIAL_MARKET_ADDRESSES.dev]: dev.files, [OFFICIAL_MARKET_ADDRESSES.main]: main.files });
  // No lane set (every box, dev and alpha ones included): main. Spine is never asked.
  assert.equal((await refreshMarket(official, { deps: hosts.deps })).address, OFFICIAL_MARKET_ADDRESSES.main);
  await setOfficialMarketLane('dev');
  assert.equal((await refreshMarket(official, { deps: hosts.deps })).pointer.commit, 'dev');
  await setOfficialMarketLane('main');
  const accepted = await refreshMarket(official, { deps: hosts.deps });
  assert.equal(accepted.address, OFFICIAL_MARKET_ADDRESSES.main, 'the lower sequence of the main lane is not "older"');
  assert.equal(accepted.pointer.commit, 'main');
  // The lane is kept in market-sources.json, on the official entry; the official Market stays on.
  const stored = JSON.parse(readFileSync(path.join(directory, 'market-sources.json'), 'utf8'));
  assert.deepEqual(stored.active_sources.find((entry: { id: string }) => entry.id === 'official'), { id: 'official', enabled: true, lane: 'main' });
  await assert.rejects(setOfficialMarketLane('stable'), /The official Market lane is main or dev/);
  await assert.rejects(setOfficialMarketLane('test/andrew'), /main or dev/);
}));

test('the official lane: the setting, else main; a lane this reader does not know reads as main', withStore(async (directory) => {
  assert.deepEqual(officialMarketAddress(), { address: 'https://market.youeye.me/', lane: 'main', from: 'default' });
  assert.deepEqual(officialMarketAddress({ lane: 'dev' }), { address: 'https://market.youeye.me/dev/', lane: 'dev', from: 'setting' });
  assert.deepEqual(officialMarketAddress({ lane: 'main' }), { address: 'https://market.youeye.me/', lane: 'main', from: 'setting' });
  // An alpha box from before 0.6.20 has no lane in its list: it reads main now (owner, 2026-11-23).
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [{ id: 'official', enabled: true }] }));
  assert.equal((await getConfiguredMarketSources())[0].lane, undefined);
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [{ id: 'official', enabled: false, lane: 'test/native' }] }));
  const [kept] = await getConfiguredMarketSources();
  assert.deepEqual([kept.enabled, kept.lane, officialMarketAddress(kept).address], [false, undefined, 'https://market.youeye.me/']);
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [{ id: 'official', enabled: true, lane: 'dev' }] }));
  assert.equal(officialMarketAddress((await getConfiguredMarketSources())[0]).address, 'https://market.youeye.me/dev/');
}));

test('an unreachable market keeps the accepted state and reports the error', withStore(async () => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  await refreshMarket(custom, { deps: hosts.deps });
  hosts.state.down = true;
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/market\.json could not be fetched/));
  const status = await readMarketRefreshStatus('custom-1');
  assert.match(status.error!, /could not be fetched/);
  assert.ok(status.refreshed_at, 'the last good refresh is still known');
  assert.equal((await readAcceptedMarket(custom))!.index.apps.length, 3);
  // A reader still gets the market.
  assert.equal((await currentMarket(custom, { deps: hosts.deps })).index.apps.length, 3);
  // HTTP errors and a market that vanished are the same.
  hosts.state.down = false;
  hosts.state.status[ADDRESS + MARKET_POINTER_FILE] = 500;
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/market\.json: HTTP 500/));
  assert.equal((await readAcceptedMarket(custom))!.index.apps.length, 3);
}));

test('a damaged copy is noticed when it is read and repaired by the next refresh, without lowering the floor', withStore(async (directory) => {
  const built = buildFixtureMarket(one());
  const sites = { [ADDRESS]: built.files };
  const hosts = fakeMarketHosts(sites);
  await refreshMarket(custom, { deps: hosts.deps });
  writeFileSync(path.join(directory, 'markets/custom-1', built.bundlePaths.beta), 'changed on disk');
  resetMarketStoreMemory();
  const damaged = (await readAcceptedMarket(custom))!;
  assert.deepEqual(damaged.damaged, [built.bundlePaths.beta]);
  assert.equal(damaged.bundles.get('beta')!.ok, false);
  assert.equal(damaged.bundles.get('alpha')!.ok, true);
  hosts.take();
  const repaired = await refreshMarket(custom, { deps: hosts.deps });
  assert.deepEqual(hosts.take(), [MARKET_POINTER_FILE, built.bundlePaths.beta], 'no ETag is sent for a damaged copy; only the damaged bundle is fetched');
  assert.deepEqual(repaired.damaged, []);
  // A damaged copy does not forget the floor.
  writeFileSync(path.join(directory, 'markets/custom-1', built.indexPath), 'gone');
  resetMarketStoreMemory();
  assert.equal(await readAcceptedMarket(custom), null);
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: 1794000000 })).files;
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/lower than the 1795000000/));
}));

test('a market larger than this box accepts is refused before its bundles are fetched', withStore(async () => {
  const built = buildFixtureMarket(one());
  const index = JSON.parse(built.files.get(built.indexPath)!.toString('utf8'));
  const huge = { ...index, apps: Array.from({ length: 2001 }, (_, n) => ({ id: `app${n}`, kind: 'container', name: `App ${n}` })) };
  const bytes = Buffer.from(JSON.stringify(huge));
  const sha = sha256Hex(bytes);
  const pointer = Buffer.from(JSON.stringify({ ...JSON.parse(built.pointer.toString('utf8')), index: { path: `h/index/${sha}.json`, sha256: sha, size: bytes.length } }));
  const hosts = fakeMarketHosts({ [ADDRESS]: new Map([[MARKET_POINTER_FILE, pointer], [`h/index/${sha}.json`, bytes]]) });
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/too large: the index lists 2001 apps/));
  assert.equal(hosts.requests.length, 2);
  assert.equal(await readAcceptedMarket(custom), null);
}));

// ─── The fetcher's address rules ──────────────────────────

test('a market at a private address, with credentials, without HTTPS or behind a redirect is refused', withStore(async () => {
  const built = buildFixtureMarket(one());
  const address = 'https://rebind.example.org/market/';
  // The host resolves to a private address: nothing is requested.
  for (const resolved of [['10.0.0.5'], ['93.184.216.34', '192.168.1.10'], ['169.254.169.254'], ['fd00::1'], ['127.0.0.1']]) {
    const hosts = fakeMarketHosts({ [address]: built.files }, { resolve: { 'rebind.example.org': resolved } });
    await assert.rejects(refreshMarket(customMarketSource(address, { id: 'custom-1' }), { deps: hosts.deps }), refused(/A market must be on a public server/));
    assert.equal(hosts.requests.length, 0, resolved.join(','));
  }
  const hosts = fakeMarketHosts({ [address]: built.files });
  for (const [bad, pattern] of [
    ['http://markets.example.org/m/', /must start with https/], ['https://user:pw@markets.example.org/m/', /credentials/],
    ['https://localhost/m/', /public server/], ['https://box.local/m/', /public server/], ['https://192.168.1.2/m/', /public server/],
    ['https://[::1]/m/', /public server/], ['https://markets.example.org/m/?x=1', /query/],
  ] as const) {
    await assert.rejects(openMarketSession(bad, hosts.deps), (error: unknown) => error instanceof MarketFetchError && pattern.test(error.message), bad);
    await assert.rejects(previewMarket(bad, hosts.deps), MarketRefreshError, bad);
  }
  assert.equal(hosts.requests.length, 0);

  // A redirect is never followed, whatever it points at.
  for (const status of [301, 302, 307, 308]) {
    const moved = fakeMarketHosts({ [address]: built.files }, { status: { [address + MARKET_POINTER_FILE]: status } });
    await assert.rejects(refreshMarket(customMarketSource(address, { id: 'custom-1' }), { deps: moved.deps }), refused(new RegExp(`HTTP ${status} \\(a market must not redirect\\)`)));
    assert.equal(moved.requests.length, 1);
  }
  // Every request of a refresh goes to the one checked address.
  const good = fakeMarketHosts({ [address]: built.files });
  await refreshMarket(customMarketSource(address, { id: 'custom-1' }), { deps: good.deps });
  assert.ok(good.requests.length >= 5 && good.requests.every((request) => request.pinned === '93.184.216.34'));
}));

test('each kind of file has its size limit; only market paths can be asked for', async () => {
  const address = 'https://markets.example.org/big/';
  const sizes: Array<[string, keyof typeof MARKET_LIMITS]> = [
    [MARKET_POINTER_FILE, 'pointer'], [`h/index/${'a'.repeat(64)}.json`, 'index'],
    [`h/apps/demo/${'b'.repeat(64)}.json`, 'bundle'], [`h/files/${'c'.repeat(64)}.png`, 'file'],
  ];
  assert.deepEqual(MARKET_LIMITS, { pointer: 64 * 1024, index: 4 * 1024 * 1024, bundle: 1024 * 1024, file: 5 * 1024 * 1024 });
  for (const [file, kind] of sizes) {
    const limits: number[] = [];
    const session = await openMarketSession(address, {
      resolve: async () => ['93.184.216.34'],
      // A transport that ignores the limit: the session still refuses what it announces or hands over.
      get: async (_url, _pinned, request) => {
        limits.push(request.maxBytes);
        return { status: 200, headers: { 'content-length': String(MARKET_LIMITS[kind] + 1) }, body: Buffer.alloc(8) };
      },
    });
    await assert.rejects(session.get(file, kind), (error: unknown) => error instanceof MarketFetchError && /is larger than/.test(error.message), file);
    assert.deepEqual(limits, [MARKET_LIMITS[kind]], `${kind} is fetched with its own limit`);
    session.close();
  }
  const session = await openMarketSession(address, { resolve: async () => ['93.184.216.34'], get: async () => ({ status: 200, headers: {}, body: Buffer.alloc(100) }) });
  await assert.rejects(session.get(`h/index/${'a'.repeat(64)}.json`, 'index', { maxBytes: 99 }), /larger than the 99 bytes/, 'the recorded size is the limit');
  for (const bad of ['index.html', '../secret', 'h/files/x.png', 'h/apps/demo/readme.txt', 'https://elsewhere.example.org/market.json', `h/files/${'c'.repeat(64)}.html`]) {
    await assert.rejects(session.get(bad, 'file'), /Not a market file path/, bad);
  }
  await assert.rejects((await openMarketSession(address, { resolve: async () => ['93.184.216.34'], get: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) }))
    .get(MARKET_POINTER_FILE, 'pointer'), /is empty/);
});

// ─── Pictures ─────────────────────────────────────────────

test('a picture is fetched once, checked against its hash, kept, and only when the accepted market names it', withStore(async (directory) => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  await refreshMarket(custom, { deps: hosts.deps });
  hosts.take();
  const icon = built.picturePaths.alpha['icon.svg'];
  const shot = built.picturePaths.alpha['screenshots/a.webp'];

  // Not named, not a picture path, another source's store: null, and no request at all.
  const unnamed = `h/files/${sha256Hex('something else')}.png`;
  for (const file of [unnamed, MARKET_POINTER_FILE, built.indexPath, built.bundlePaths.alpha, '../state.json', 'h/files/x.svg', '']) {
    assert.equal(await readMarketPicture(custom, file, { deps: hosts.deps }), null, file);
  }
  assert.equal(await readMarketPicture(customMarketSource('https://markets.example.org/nobody/', { id: 'custom-2' }), icon, { deps: hosts.deps }), null);
  assert.equal(hosts.requests.length, 0);

  // Named: simultaneous readers share one fetch; afterwards the store answers.
  const answers = await Promise.all([1, 2, 3].map(() => readMarketPicture(custom, icon, { deps: hosts.deps })));
  assert.deepEqual(hosts.take(), [icon]);
  assert.ok(answers.every((answer) => answer!.contentType === 'image/svg+xml' && answer!.bytes.equals(ICON)));
  assert.deepEqual(hashedFiles(directory, 'files'), [icon.slice('h/files/'.length)]);
  assert.deepEqual((await readMarketPicture(custom, icon, { deps: hosts.deps }))!.bytes, ICON);
  assert.equal(hosts.requests.length, 0, 'served from the store');

  // Other bytes than the path's hash: refused, not kept, and not asked again for a minute.
  hosts.state.replace[ADDRESS + shot] = Buffer.from('<svg><script>alert(1)</script></svg>');
  let now = 1_000_000;
  await assert.rejects(readMarketPicture(custom, shot, { deps: hosts.deps, now: () => now }), refused(/not the file its hash names/));
  await assert.rejects(readMarketPicture(custom, shot, { deps: hosts.deps, now: () => now + 30_000 }), refused(/not the file its hash names/));
  assert.deepEqual(hosts.take(), [shot], 'the failure is remembered: one request');
  assert.deepEqual(hashedFiles(directory, 'files'), [icon.slice('h/files/'.length)]);
  delete hosts.state.replace[ADDRESS + shot];
  now += 61_000;
  assert.deepEqual((await readMarketPicture(custom, shot, { deps: hosts.deps, now: () => now }))!.bytes, SHOT);

  // A stored picture that was changed on disk is fetched again, never served.
  writeFileSync(path.join(directory, 'markets/custom-1', icon), '<svg onload="alert(1)"/>');
  assert.deepEqual((await readMarketPicture(custom, icon, { deps: hosts.deps }))!.bytes, ICON);
  // A picture over 5 MiB is refused by the fetcher's limit.
  const big = Buffer.alloc(MARKET_LIMITS.file + 1, 1);
  const large = buildFixtureMarket(one({ sequence: 1795000900, apps: [{ id: 'alpha', pictures: { 'icon.svg': ICON, 'screenshots/big.png': big } }] }));
  const site = fakeMarketHosts({ [ADDRESS]: large.files });
  await refreshMarket(custom, { deps: site.deps });
  await assert.rejects(readMarketPicture(custom, large.picturePaths.alpha['screenshots/big.png'], { deps: site.deps }), refused(/larger than the 5242880 bytes/));
  // The picture the new market no longer names was removed with the accept; the icon it still names stayed.
  assert.deepEqual(hashedFiles(directory, 'files'), [icon.slice('h/files/'.length)]);
}));

// ─── When a market is asked ───────────────────────────────

/**
 * Wait until `done` holds, for work a reader started in the background: no fixed sleep, which a loaded machine can
 * outlast (a 20 ms sleep failed once under the full suite). Fails after 10 s.
 */
async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const answered = (hosts: ReturnType<typeof fakeMarketHosts>) => () => hosts.requests.some((request) => request.status !== 0);

test('readers use the store: no request until the interval is over, then one in the background', withStore(async () => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  let now = Date.parse('2026-11-18T12:00:00Z');
  const options = { deps: hosts.deps, now: () => now, random: () => 0.5 };

  // First use: the store is empty, so the reader waits for the market.
  assert.equal((await currentMarket(custom, options)).index.apps.length, 3);
  assert.equal(hosts.take().length, 5);
  // Fifty readers within the interval: not one request.
  for (let n = 0; n < 50; n += 1) { now += 5_000; await currentMarket(custom, options); }
  assert.equal(hosts.requests.length, 0);
  // The interval is 5 minutes plus 5 % here (random 0.5): at 5 min 10 s still nothing…
  now = Date.parse('2026-11-18T12:05:10Z');
  await currentMarket(custom, options);
  assert.equal(hosts.requests.length, 0);
  // …at 5 min 15 s one conditional request, in the background (the reader already has its answer).
  now = Date.parse('2026-11-18T12:05:15Z');
  await currentMarket(custom, options);
  // The background attempt is over once it is recorded.
  await until(async () => (await readMarketRefreshStatus(custom.id)).checked_at === new Date(now).toISOString(),
    'the background refresh');
  assert.deepEqual(hosts.requests.map((request) => [request.path, request.status]), [[MARKET_POINTER_FILE, 304]]);
  hosts.take();
  await currentMarket(custom, options);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hosts.requests.length, 0, 'the next wait started with that attempt');
}));

test('the wait between refreshes is five minutes plus 0 to 10 %', () => {
  assert.equal(MARKET_REFRESH_INTERVAL_MS, 5 * 60 * 1000);
  assert.equal(marketRefreshWait(() => 0), 300_000);
  assert.equal(marketRefreshWait(() => 0.999999), 330_000);
  assert.equal(marketRefreshWait(() => 7), 330_000, 'a broken random source cannot stretch the wait');
  assert.equal(marketRefreshWait(() => -1), 300_000);
  const waits = Array.from({ length: 2000 }, () => marketRefreshWait());
  assert.ok(waits.every((wait) => wait >= 300_000 && wait <= 330_000));
  assert.ok(new Set(waits).size > 100, 'the jitter is random per attempt');
});

test('"check for updates" asks each source once and waits; a failure falls back to the store', withStore(async () => {
  const first = buildFixtureMarket(one());
  const sites = { [ADDRESS]: first.files };
  const hosts = fakeMarketHosts(sites);
  let now = Date.parse('2026-11-18T12:00:00Z');
  const options = { deps: hosts.deps, now: () => now, random: () => 0 };
  await currentMarket(custom, options);
  hosts.take();

  // A minute later the market has a new commit. A plain reader does not see it yet…
  now += 60_000;
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: 1795000100, commit: 'bbbb2222' })).files;
  assert.equal((await currentMarket(custom, options)).pointer.commit, 'aaaa1111');
  assert.equal(hosts.requests.length, 0);
  // …an explicit check does, and waits for it.
  requestMarketRefresh(null, now);
  assert.equal((await currentMarket(custom, options)).pointer.commit, 'bbbb2222');
  assert.ok(hosts.take().includes(MARKET_POINTER_FILE));
  // The same request is not repeated for the next reader, nor for a second check within seconds.
  await currentMarket(custom, options);
  now += 5_000;
  requestMarketRefresh(null, now);
  await currentMarket(custom, options);
  assert.equal(hosts.requests.length, 0);

  // A check of one source (an app update) does not make readers of another source wait.
  const other = customMarketSource('https://markets.example.org/second/', { id: 'custom-2' });
  sites['https://markets.example.org/second/'] = first.files;
  await currentMarket(other, options);
  hosts.take();
  now += 60_000;
  requestMarketRefresh('custom-2', now);
  await currentMarket(custom, options);
  assert.equal(hosts.requests.length, 0);
  await currentMarket(other, options);
  assert.deepEqual(hosts.take().map((file) => file), [MARKET_POINTER_FILE]);

  // An explicit check while the market is down: the reader gets the store, and the error is recorded.
  now += 60_000;
  hosts.state.down = true;
  requestMarketRefresh(null, now);
  assert.equal((await currentMarket(custom, options)).pointer.commit, 'bbbb2222');
  assert.match((await readMarketRefreshStatus('custom-1')).error!, /could not be fetched/);
  assert.equal(hosts.take().length, 1);
  await currentMarket(custom, options);
  assert.equal(hosts.requests.length, 0, 'not asked again for this check');
}));

test('an empty store is not hammered: a failed first read is repeated after 30 s at the earliest', withStore(async () => {
  const hosts = fakeMarketHosts({});
  let now = Date.parse('2026-11-18T12:00:00Z');
  const options = { deps: hosts.deps, now: () => now, random: () => 0 };
  await assert.rejects(currentMarket(custom, options), refused(/market\.json: HTTP 404/));
  for (let n = 0; n < 5; n += 1) { now += 5_000; await assert.rejects(currentMarket(custom, options), refused(/HTTP 404/)); }
  assert.equal(hosts.requests.length, 1);
  now += 6_000;
  await assert.rejects(currentMarket(custom, options), MarketRefreshError);
  assert.equal(hosts.requests.length, 2);
}));

test('a source that was re-pointed is read from its new address at once, not after the old address\'s wait', withStore(async () => {
  const elsewhere = 'https://markets.example.org/other/';
  const hosts = fakeMarketHosts({ [ADDRESS]: buildFixtureMarket(one()).files, [elsewhere]: buildFixtureMarket(one({ sequence: 5, commit: 'other', apps: [{ id: 'alpha' }] })).files });
  let now = Date.parse('2026-11-18T12:00:00Z');
  const options = { deps: hosts.deps, now: () => now, random: () => 0 };
  await currentMarket(custom, options);
  now += 10_000;
  const moved = { ...custom, url: elsewhere };
  assert.equal((await currentMarket(moved, options)).pointer.commit, 'other');
  // The same after a restart: the recorded attempt was for the old address.
  now += 10_000;
  resetMarketStoreMemory();
  assert.equal((await currentMarket(custom, options)).pointer.commit, 'aaaa1111');
  // A re-pointed source whose new market cannot be read has nothing to list; it is asked again after 30 s, not 5 min.
  now += 10_000;
  const broken = { ...custom, url: 'https://markets.example.org/nothing/' };
  await assert.rejects(currentMarket(broken, options), refused(/HTTP 404/));
  hosts.take();
  now += 10_000;
  await assert.rejects(currentMarket(broken, options), refused(/HTTP 404/));
  assert.equal(hosts.requests.length, 0);
  now += 25_000;
  await assert.rejects(currentMarket(broken, options), refused(/HTTP 404/));
  assert.equal(hosts.requests.length, 1);
}));

test('one refresh per source at a time, shared by its callers and by a second copy of the module', withStore(async () => {
  const built = buildFixtureMarket(one());
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files }, { before: (url) => (url.endsWith(MARKET_POINTER_FILE) ? held : undefined) });
  // The Control Panel's bundle holds the module more than once; both copies must share the running refresh.
  const copy = await import(`../src/lib/market/market-store.ts?copy=${Date.now()}`) as typeof import('../src/lib/market/market-store');
  assert.notEqual(copy.refreshMarket, refreshMarket, 'a second module instance');
  const running = [refreshMarket(custom, { deps: hosts.deps }), copy.refreshMarket(custom, { deps: hosts.deps }),
    currentMarket(custom, { deps: hosts.deps }), copy.currentMarket(custom, { deps: hosts.deps })];
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const results = await Promise.all(running);
  assert.ok(results.every((accepted) => accepted.pointerSHA256 === results[0].pointerSHA256));
  assert.deepEqual(hosts.requests.filter((request) => request.path === MARKET_POINTER_FILE).length, 1);
  assert.equal(hosts.requests.length, 5);
  // The second copy reads what the first accepted, from memory shared by both.
  assert.equal((await copy.readAcceptedMarket(custom))!.pointer.sequence, 1795000000);
}));

test('after a restart the timer continues from the recorded attempt', withStore(async () => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  const start = Date.parse('2026-11-18T12:00:00Z');
  await refreshMarket(custom, { deps: hosts.deps, now: () => start });
  hosts.take();
  resetMarketStoreMemory();   // a new process
  await currentMarket(custom, { deps: hosts.deps, now: () => start + 120_000, random: () => 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hosts.requests.length, 0, 'two minutes after the last attempt: nothing');
  resetMarketStoreMemory();
  await currentMarket(custom, { deps: hosts.deps, now: () => start + 301_000, random: () => 0 });
  await until(answered(hosts), 'the background request');
  assert.equal(hosts.requests.length, 1);
}));

test('after a restart an empty store whose last attempt failed is asked again 30 s later, as in the same process', withStore(async () => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  const start = Date.parse('2026-11-18T12:00:00Z');
  hosts.state.down = true;   // the network is not up yet (first boot)
  await assert.rejects(currentMarket(custom, { deps: hosts.deps, now: () => start, random: () => 0 }));
  hosts.state.down = false;
  hosts.take();
  resetMarketStoreMemory();   // a new process
  await assert.rejects(currentMarket(custom, { deps: hosts.deps, now: () => start + 20_000, random: () => 0 }), refused(/could not be fetched/));
  assert.equal(hosts.requests.length, 0, '20 s after the failed attempt: nothing');
  assert.equal((await currentMarket(custom, { deps: hosts.deps, now: () => start + 31_000, random: () => 0 })).pointer.commit, 'aaaa1111');
}));

test('an attempt made while the clock was ahead does not hold the market back once the clock is corrected', withStore(async () => {
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  const ahead = Date.parse('2027-06-01T00:00:00Z');   // the box booted with its clock half a year ahead
  const right = Date.parse('2026-11-18T12:00:00Z');
  hosts.state.down = true;
  await assert.rejects(currentMarket(custom, { deps: hosts.deps, now: () => ahead, random: () => 0 }));
  hosts.state.down = false;
  hosts.take();
  // The clock is corrected: the empty store is read at once.
  assert.equal((await currentMarket(custom, { deps: hosts.deps, now: () => right, random: () => 0 })).pointer.commit, 'aaaa1111');
  assert.ok(hosts.take().length > 0);

  // With a market in the store: an attempt made while the clock was ahead neither stops the background refresh nor
  // an explicit check.
  for (const background of [true, false]) {
    resetMarketStoreMemory();
    await refreshMarket(custom, { deps: hosts.deps, now: () => ahead, random: () => 0 }).catch(() => undefined);
    hosts.take();
    if (background) {
      await currentMarket(custom, { deps: hosts.deps, now: () => right + 60_000, random: () => 0 });
    } else {
      requestMarketRefresh(undefined, right + 60_000);
      await currentMarket(custom, { deps: hosts.deps, now: () => right + 61_000, random: () => 0 });
    }
    await until(answered(hosts), background ? 'the background request' : 'the explicit check');
    assert.ok(hosts.requests.length > 0, background ? 'the market is asked in the background' : 'the explicit check asks the market');
    hosts.take();
  }
}));

// ─── The files this replaces ──────────────────────────────

test('the old catalog release files go once the official store holds an accepted index, not before', withStore(async (directory) => {
  mkdirSync(path.join(directory, 'market-releases'), { recursive: true });
  writeFileSync(path.join(directory, 'market-releases', 'official.json'), '{}');
  writeFileSync(path.join(directory, 'market-releases', `catalog-${'a'.repeat(64)}.tar`), 'tar');
  writeFileSync(path.join(directory, 'catalog-cache.json'), '{}');
  const built = buildFixtureMarket(one());
  const hosts = fakeMarketHosts({ [OFFICIAL_MARKET_ADDRESSES.main]: built.files, [ADDRESS]: built.files });

  // A custom market's accept does not touch them; neither does a failed official refresh.
  await refreshMarket(custom, { deps: hosts.deps });
  hosts.state.down = true;
  await assert.rejects(refreshMarket(official, { deps: hosts.deps }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(path.join(directory, 'market-releases/official.json')));
  assert.ok(existsSync(path.join(directory, 'catalog-cache.json')));

  hosts.state.down = false;
  await refreshMarket(official, { deps: hosts.deps });
  await until(() => !existsSync(path.join(directory, 'catalog-cache.json')), 'the old files to go');
  assert.equal(existsSync(path.join(directory, 'market-releases')), false);
  assert.equal(existsSync(path.join(directory, 'catalog-cache.json')), false);
  assert.ok(existsSync(path.join(marketStoreDirectory('official'), 'state.json')));
}));

test('a preview reads a market and writes nothing', withStore(async (directory) => {
  const built = buildFixtureMarket(one({ name: 'Friend\'s apps', publisher: 'A friend' }));
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files });
  const preview = await previewMarket('https://markets.example.org/friend/market.json', hosts.deps);
  assert.deepEqual(preview, {
    address: ADDRESS, name: 'Friend\'s apps', publisher: 'A friend', commit: 'aaaa1111', sequence: 1795000000,
    sequence_date: '2026-11-18T11:06:40.000Z', apps: 3, apps_with_setup: 1, native: 0, bundles: 1,
  });
  assert.deepEqual(hosts.take(), [MARKET_POINTER_FILE, built.indexPath], 'no bundle is fetched for a preview');
  assert.deepEqual(readdirSync(directory), []);
  await assert.rejects(previewMarket('https://markets.example.org/nothing/', hosts.deps), refused(/market\.json: HTTP 404/));
}));
