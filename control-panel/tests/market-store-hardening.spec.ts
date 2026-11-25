/**
 * The box's copy of a market under a market that misbehaves (src/lib/market/market-store.ts): a refresh that is held
 * open, never ends, or fails again and again; a `sequence` that is no time; pictures asked for all at once.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MARKET_POINTER_FILE, MARKET_SEQUENCE_MAX, readMarketPointer, sha256Hex } from '../src/lib/market/market-format';
import {
  MARKET_READER_WAIT_MS, MARKET_REFRESH_DEADLINE_MS, MARKET_SEQUENCE_AHEAD_SECONDS, MarketRefreshError, PICTURE_FETCH_LIMITS,
  currentMarket, marketSourceView, previewMarket, readAcceptedMarket, readMarketPicture, readMarketRefreshStatus, refreshMarket,
  refreshMarketForReader, removeMarketStoresExcept, requestMarketRefresh, resetMarketStoreMemory,
} from '../src/lib/market/market-store';
import { OFFICIAL_MARKET_ADDRESSES, OFFICIAL_MARKET_AS_CUSTOM, customMarketSource, setOfficialMarketLane } from '../src/lib/market/source';
import { buildFixtureMarket, fakeMarketHosts, type FixtureMarket } from './fixtures/market';

const ADDRESS = 'https://markets.example.org/friend/';
const OLD = 'https://old.example/';
const NEW = 'https://new.example/';
const ACCEPTED_AT = '2026-11-18T10:00:00.000Z';
const custom = customMarketSource(ADDRESS, { id: 'custom-1', name: 'Friend', accepted_at: ACCEPTED_AT });

const one = (overrides: Partial<FixtureMarket> = {}): FixtureMarket => ({
  sequence: 1795000000, commit: 'aaaa1111', apps: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }], ...overrides,
});

function withStore(work: (directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'youeye-market-hardening-'));
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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every file below `markets/<id>/` (relative paths), without refresh.json. */
function storeFiles(directory: string, id = 'custom-1'): string[] {
  const root = path.join(directory, 'markets', id);
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((name) => name !== 'refresh.json')
    .sort();
}
/** A gate: requests it holds stay open until `open()`. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  return { held, open };
}
const sourceList = (directory: string, entries: Array<Record<string, unknown>>) =>
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [{ id: 'official', enabled: true }, ...entries] }));

// ─── A: a refresh belongs to one source at one address ────

test('a refresh held open by one market never answers the source id at another address, and commits nothing there', withStore(async (directory) => {
  const before = buildFixtureMarket(one({ commit: 'old-market', apps: [{ id: 'evil' }] }));
  const after = buildFixtureMarket(one({ commit: 'new-market' }));
  const door = gate();
  const hosts = fakeMarketHosts({ [OLD]: before.files, [NEW]: after.files }, { before: (url) => (url.startsWith(OLD) ? door.held : undefined) });
  const oldSource = customMarketSource(OLD, { id: 'custom-1', accepted_at: ACCEPTED_AT });
  const newSource = customMarketSource(NEW, { id: 'custom-1', accepted_at: ACCEPTED_AT });

  // The old market's refresh is in flight when the owner removes it and adds another market, which gets the same id.
  sourceList(directory, [{ id: 'custom-1', url: OLD, enabled: true, priority: 1, accepted_at: ACCEPTED_AT }]);
  const stale = refreshMarket(oldSource, { deps: hosts.deps });
  stale.catch(() => {});
  await pause(10);
  sourceList(directory, [{ id: 'custom-1', url: NEW, enabled: true, priority: 1, accepted_at: ACCEPTED_AT }]);

  // Readers of the source as it is now get the new market, and do not wait for the old one (which never ends by itself).
  let released = false;
  const release = setTimeout(() => { released = true; door.open(); }, 1500);
  const listed = await currentMarket(newSource, { deps: hosts.deps });
  assert.equal(listed.address, NEW, `a reader of ${NEW} got the market of ${listed.address}`);
  assert.equal(listed.pointer.commit, 'new-market');
  assert.deepEqual(listed.index.apps.map((app) => app.id), ['alpha', 'beta', 'gamma']);
  assert.equal((await refreshMarket(newSource, { deps: hosts.deps })).address, NEW, 'an explicit refresh of the new address is its own');
  assert.equal((await refreshMarketForReader(newSource, { deps: hosts.deps })).address, NEW);
  assert.equal(released, false, 'none of this waited for the old market');

  // The old market lets go: its refresh is refused, the store still holds the new market, nothing of the old one stays.
  clearTimeout(release);
  door.open();
  await assert.rejects(stale, refused(/removed or now reads another address/));
  assert.equal((await readAcceptedMarket(newSource))!.address, NEW);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'markets/custom-1/state.json'), 'utf8')).address, NEW);
  assert.deepEqual(storeFiles(directory), ['state.json', after.indexPath, ...Object.values(after.bundlePaths)].sort());
  assert.equal((await readMarketRefreshStatus('custom-1')).error, undefined, 'the old market\'s failure is not the new source\'s error');
  assert.equal((await currentMarket(newSource, { deps: hosts.deps })).address, NEW);
}));

test('a source that is removed while its market is being read leaves no store behind', withStore(async (directory) => {
  const built = buildFixtureMarket(one());
  const door = gate();
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files }, { before: (url) => (url.endsWith(built.bundlePaths.gamma) ? door.held : undefined) });
  const running = refreshMarket(custom, { deps: hosts.deps });
  running.catch(() => {});
  // Wait for the bundles before the held one (a fixed 30 ms was too short on a loaded machine).
  for (let waited = 0; waited < 5_000 && !storeFiles(directory).some((file) => file.startsWith('attempt-')); waited += 10) await pause(10);
  assert.ok(storeFiles(directory).some((file) => file.startsWith('attempt-')), 'the bundles fetched so far are in the attempt\'s own directory');
  assert.ok(storeFiles(directory).every((file) => file.startsWith('attempt-')), 'nothing is under h/ before the commit');

  const started = Date.now();
  await removeMarketStoresExcept(['official']);
  assert.ok(Date.now() - started < 1000, 'the removal does not wait for the market');
  await assert.rejects(running, refused(/removed or now reads another address/));
  assert.equal(existsSync(path.join(directory, 'markets/custom-1')), false);
  door.open();
  await pause(30);
  assert.equal(existsSync(path.join(directory, 'markets/custom-1')), false, 'the request that was still open writes nothing when it ends');
}));

// ─── B: a refresh ends, and readers do not wait for it ────

test('the deadline and the reader\'s wait are what the documentation says', () => {
  assert.equal(MARKET_REFRESH_DEADLINE_MS, 180_000);
  assert.equal(MARKET_READER_WAIT_MS, 20_000);
  assert.ok(MARKET_REFRESH_DEADLINE_MS < 5 * 60 * 1000, 'a refresh ends before the next one is due');
});

test('a refresh ends at its deadline whatever the market does; the accepted state stays and nothing is left behind', withStore(async (directory) => {
  const first = buildFixtureMarket(one());
  const sites = { [ADDRESS]: first.files };
  let hold = false;
  const door = gate();
  const hosts = fakeMarketHosts(sites, { before: (url) => (hold && /h\/apps\//.test(url) ? door.held : undefined) });
  await refreshMarket(custom, { deps: hosts.deps });
  const accepted = storeFiles(directory);

  // A new state whose bundles are served so slowly that they never arrive.
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: 1795000100, commit: 'slow', apps: [{ id: 'alpha', version: '2.0.0' }, { id: 'beta', version: '2.0.0' }] })).files;
  hold = true;
  const release = setTimeout(() => door.open(), 3000);
  const started = Date.now();
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps, refreshDeadlineMs: 150 }), refused(/did not finish answering within/));
  assert.ok(Date.now() - started < 1500, `the refresh ended at its deadline (${Date.now() - started} ms)`);
  clearTimeout(release);
  assert.equal((await readAcceptedMarket(custom))!.pointer.commit, 'aaaa1111');
  assert.deepEqual(storeFiles(directory), accepted, 'the store holds the accepted state and nothing else');
  assert.match((await readMarketRefreshStatus('custom-1')).error!, /did not finish answering/);
  door.open();
  await pause(30);
  assert.deepEqual(storeFiles(directory), accepted, 'requests that end after the deadline write nothing');
  // The same market, answering: accepted.
  hold = false;
  assert.equal((await refreshMarket(custom, { deps: hosts.deps })).pointer.commit, 'slow');
}));

test('a reader that asked for a fresh copy waits a bounded time, then gets the store; the refresh goes on', withStore(async () => {
  const first = buildFixtureMarket(one());
  const sites = { [ADDRESS]: first.files };
  let hold = false;
  const door = gate();
  const hosts = fakeMarketHosts(sites, { before: () => (hold ? door.held : undefined) });
  let now = Date.parse('2026-11-18T12:00:00Z');
  const options = { deps: hosts.deps, now: () => now, random: () => 0, readerWaitMs: 120, refreshDeadlineMs: 5000 };
  await currentMarket(custom, options);

  now += 60_000;
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: 1795000100, commit: 'bbbb2222' })).files;
  hold = true;
  requestMarketRefresh(null, now);
  const started = Date.now();
  const stale = await currentMarket(custom, options);
  const waited = Date.now() - started;
  assert.equal(stale.pointer.commit, 'aaaa1111', 'the store answers when the market does not');
  assert.ok(waited >= 100 && waited < 1000, `the reader waited ${waited} ms`);
  // The next readers of the same check do not wait at all.
  const again = Date.now();
  await currentMarket(custom, options);
  assert.ok(Date.now() - again < 80);
  // The refresh was not given up: when the market answers, the store has the new state.
  door.open();
  await pause(50);
  assert.equal((await readAcceptedMarket(custom))!.pointer.commit, 'bbbb2222');
}));

test('an empty store makes readers wait once, counted from the start of the refresh; a market that never answers is then read in the background only', withStore(async () => {
  const built = buildFixtureMarket(one());
  let hold = true;
  let door = gate();
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files }, { before: () => (hold ? door.held : undefined) });
  let now = Date.parse('2026-11-18T12:00:00Z');
  const options = { deps: hosts.deps, now: () => now, random: () => 0, readerWaitMs: 150, refreshDeadlineMs: 400 };

  const started = Date.now();
  await assert.rejects(currentMarket(custom, options), refused(/still being read/));
  const waited = Date.now() - started;
  assert.ok(waited >= 130 && waited < 390, `the first reader waited ${waited} ms`);
  // A second read of the same page: the time is over, so it is told at once.
  const second = Date.now();
  await assert.rejects(currentMarket(custom, options), refused(/still being read/));
  assert.ok(Date.now() - second < 80, 'the wait counts from the start of the refresh, not from each reader');
  // The refresh itself ends at its deadline.
  await pause(400);
  assert.match((await readMarketRefreshStatus('custom-1')).error!, /did not finish answering/);
  assert.equal(hosts.take().length, 1);

  // 31 s later it is due again. Readers no longer wait for a market that failed that slowly: one request, in the background.
  now += 31_000;
  door = gate();
  const third = Date.now();
  await assert.rejects(currentMarket(custom, options), refused(/did not finish answering/));
  assert.ok(Date.now() - third < 80, 'no reader waits for it a second time');
  await pause(30);
  assert.equal(hosts.take().length, 1, 'it is asked again all the same');
  // When it answers, it is accepted, and the next reader has it.
  hold = false;
  door.open();
  await pause(450);
  now += 31_000;
  await currentMarket(custom, options).catch(() => undefined);
  await pause(50);
  assert.equal((await currentMarket(custom, options)).pointer.commit, 'aaaa1111');
}));

test('a preview of a market that does not finish answering ends like a reader\'s wait', withStore(async (directory) => {
  const built = buildFixtureMarket(one());
  const door = gate();
  const hosts = fakeMarketHosts({ [ADDRESS]: built.files }, { before: (url) => (/h\/index\//.test(url) ? door.held : undefined) });
  const release = setTimeout(() => door.open(), 3000);
  const started = Date.now();
  await assert.rejects(previewMarket(ADDRESS, hosts.deps, { readerWaitMs: 120 }), refused(/The market did not answer in time/));
  assert.ok(Date.now() - started < 1500, `the preview ended after ${Date.now() - started} ms`);
  clearTimeout(release);
  door.open();
  assert.deepEqual(readdirSync(directory), []);
}));

// ─── C: a failed refresh leaves nothing behind ────────────

test('failed refreshes do not pile files up: with no accepted state nothing stays, with one only what it names', withStore(async (directory) => {
  const sites: Record<string, Map<string, Buffer>> = {};
  const hosts = fakeMarketHosts(sites);
  // A market that publishes a new index each time, always with one bundle missing: it never completes a first accept.
  const broken = (round: number) => {
    const built = buildFixtureMarket(one({ sequence: 1795000000 + round, commit: `round-${round}`,
      apps: [{ id: 'alpha', version: `1.0.${round}` }, { id: 'beta', version: `1.0.${round}` }, { id: 'gamma', version: `1.0.${round}` }, { id: 'omega', version: `1.0.${round}` }] }));
    built.files.delete(built.bundlePaths.omega);
    return built;
  };
  for (let round = 1; round <= 3; round += 1) {
    sites[ADDRESS] = broken(round).files;
    await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/h\/apps\/omega\/[0-9a-f]{64}\.json: HTTP 404/));
    assert.deepEqual(storeFiles(directory), [], `after failed refresh ${round}`);
    assert.equal(existsSync(path.join(directory, 'markets/custom-1/h')), false);
  }
  assert.equal(await readAcceptedMarket(custom), null);

  // With an accepted state: the same market fails three more times; the store holds exactly the accepted files.
  const good = buildFixtureMarket(one());
  sites[ADDRESS] = good.files;
  await refreshMarket(custom, { deps: hosts.deps });
  const accepted = ['state.json', good.indexPath, ...Object.values(good.bundlePaths)].sort();
  assert.deepEqual(storeFiles(directory), accepted);
  hosts.take();
  for (let round = 4; round <= 6; round += 1) {
    const built = broken(1000 + round);
    // alpha is the accepted market's bundle again: it is on this box and is not fetched.
    const kept = buildFixtureMarket(one({ sequence: 1795002000 + round, commit: `round-${round}`, apps: [{ id: 'alpha' }, { id: 'beta', version: `3.0.${round}` }, { id: 'omega', version: `3.0.${round}` }] }));
    kept.files.delete(kept.bundlePaths.omega);
    sites[ADDRESS] = round === 4 ? built.files : kept.files;
    await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/h\/apps\/omega\/[0-9a-f]{64}\.json: HTTP 404/));
    const asked = hosts.take();
    if (round > 4) assert.equal(asked.includes(kept.bundlePaths.alpha), false, 'a bundle of the accepted state is not fetched again');
    assert.deepEqual(storeFiles(directory), accepted, `after failed refresh ${round}`);
    assert.equal((await readAcceptedMarket(custom))!.pointer.commit, 'aaaa1111');
    assert.deepEqual((await readAcceptedMarket(custom))!.damaged, []);
  }
}));

test('what an interrupted refresh or an older version left in the store goes with the next attempt', withStore(async (directory) => {
  const built = buildFixtureMarket(one());
  const sites: Record<string, Map<string, Buffer>> = {};
  const hosts = fakeMarketHosts(sites);
  const store = path.join(directory, 'markets/custom-1');
  // Bundles a failed refresh wrote under their final names (before attempts had their own directory), and the
  // directory of an attempt that a restart cut off twenty minutes ago; one of a refresh that may still run elsewhere.
  const stray = `h/apps/zeta/${'e'.repeat(64)}.json`;
  mkdirSync(path.join(store, 'h/apps/zeta'), { recursive: true });
  writeFileSync(path.join(store, stray), 'left behind');
  for (const name of ['attempt-4242-0a0b0c0d0e0f', 'attempt-4243-0a0b0c0d0e0f']) {
    mkdirSync(path.join(store, name, 'h/apps/alpha'), { recursive: true });
    writeFileSync(path.join(store, name, 'h/apps/alpha/partial.json'), 'half a bundle');
  }
  const longAgo = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(path.join(store, 'attempt-4242-0a0b0c0d0e0f'), longAgo, longAgo);

  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/HTTP 404/));
  assert.deepEqual(storeFiles(directory), ['attempt-4243-0a0b0c0d0e0f/h/apps/alpha/partial.json'], 'only the attempt that is not old enough to be dead stays');

  // The same with an accepted state in the store: the stray file is removed, the accepted files stay.
  sites[ADDRESS] = built.files;
  await refreshMarket(custom, { deps: hosts.deps });
  mkdirSync(path.join(store, 'h/apps/zeta'), { recursive: true });
  writeFileSync(path.join(store, stray), 'left behind');
  hosts.state.down = true;
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/could not be fetched/));
  assert.equal(existsSync(path.join(store, stray)), false);
  assert.equal((await readAcceptedMarket(custom))!.index.apps.length, 3);
  assert.deepEqual((await readAcceptedMarket(custom))!.damaged, []);
}));

// ─── D: `sequence` is a time ──────────────────────────────

test('sequence is seconds since the epoch: a number that is no time is not a pointer', () => {
  assert.equal(MARKET_SEQUENCE_MAX, 4102444800);
  assert.equal(new Date(MARKET_SEQUENCE_MAX * 1000).toISOString(), '2100-01-01T00:00:00.000Z');
  const pointer = (sequence: unknown) => JSON.stringify({
    schema: 'youeye.market.v1', name: 'M', publisher: 'P', sequence,
    index: { path: `h/index/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), size: 10 },
  });
  assert.equal(readMarketPointer(pointer(MARKET_SEQUENCE_MAX)).sequence, MARKET_SEQUENCE_MAX);
  assert.equal(readMarketPointer(pointer(1)).sequence, 1);
  for (const bad of [MARKET_SEQUENCE_MAX + 1, Number.MAX_SAFE_INTEGER, 1795000000000, 1e300, 0, -5, 1.5, '1795000000', null]) {
    assert.throws(() => readMarketPointer(pointer(bad)), /market\.json: sequence/, String(bad));
  }
  assert.throws(() => readMarketPointer(pointer(Number.MAX_SAFE_INTEGER)), /must be a time in seconds, at most 4102444800 \(the year 2100\)/);
});

test('a market whose sequence is no time is refused; a copy accepted before the bound existed is dropped, never shown', withStore(async (directory) => {
  const huge = buildFixtureMarket(one({ sequence: Number.MAX_SAFE_INTEGER }));
  const sites = { [ADDRESS]: huge.files };
  const hosts = fakeMarketHosts(sites);
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps }), refused(/market\.json: sequence: must be a time in seconds/));
  await assert.rejects(previewMarket(ADDRESS, hosts.deps), refused(/market\.json: sequence/));
  assert.equal(await readAcceptedMarket(custom), null);

  // What a box accepted before: state.json with that pointer, its index and bundles in place.
  const store = path.join(directory, 'markets/custom-1');
  for (const [file, bytes] of huge.files) {
    if (file === MARKET_POINTER_FILE) continue;
    mkdirSync(path.dirname(path.join(store, file)), { recursive: true });
    writeFileSync(path.join(store, file), bytes);
  }
  writeFileSync(path.join(store, 'state.json'), JSON.stringify({
    schema: 'youeye.market-store.v1', address: ADDRESS, sequence: Number.MAX_SAFE_INTEGER,
    pointer_base64: huge.pointer.toString('base64'), pointer_sha256: sha256Hex(huge.pointer), accepted_at: ACCEPTED_AT,
  }));
  resetMarketStoreMemory();
  const view = await marketSourceView(custom);
  assert.equal(view.id, 'custom-1');
  assert.equal(view.market, null, 'it is listed without a market instead of failing the list');
  assert.equal(await readAcceptedMarket(custom), null);
  // The floor it set is gone with it: the market's real state is accepted.
  sites[ADDRESS] = buildFixtureMarket(one()).files;
  assert.equal((await refreshMarket(custom, { deps: hosts.deps })).pointer.sequence, 1795000000);
  assert.equal((await marketSourceView(custom)).market!.sequence_date, '2026-11-18T11:06:40.000Z');
}));

test('a source is always listed: one whose store cannot be read carries the reason instead of failing the list', withStore(async () => {
  const view = await marketSourceView({ ...custom, id: 'Not A Store Id' });
  assert.equal(view.market, null);
  assert.equal(view.address, ADDRESS);
  assert.match(view.refresh_error!, /copy of the market cannot be read/);
}));

test('a pointer dated more than a day ahead of the box\'s clock is refused and changes nothing', withStore(async () => {
  assert.equal(MARKET_SEQUENCE_AHEAD_SECONDS, 86_400);
  const clock = Date.parse('2026-11-18T12:00:00Z');
  const seconds = clock / 1000;
  const sites: Record<string, Map<string, Buffer>> = { [ADDRESS]: buildFixtureMarket(one({ sequence: seconds - 3600, commit: 'honest' })).files };
  const hosts = fakeMarketHosts(sites);
  const options = { deps: hosts.deps, now: () => clock };
  await refreshMarket(custom, options);

  // One second over a day ahead (a commit made with a wrong clock): refused; the accepted state and its floor stay.
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: seconds + 86_401, commit: 'future' })).files;
  await assert.rejects(refreshMarket(custom, options),
    refused(/market\.json is dated 2026-11-19T12:00:01\.000Z \(sequence 1795089601\), more than a day ahead of this YouEye's clock \(2026-11-18T12:00:00\.000Z\)/));
  await assert.rejects(previewMarket(ADDRESS, hosts.deps, { now: () => clock }), refused(/more than a day ahead/));
  const kept = (await readAcceptedMarket(custom))!;
  assert.equal(kept.pointer.commit, 'honest');
  assert.match((await readMarketRefreshStatus('custom-1')).error!, /more than a day ahead/);
  assert.equal((await currentMarket(custom, options)).pointer.commit, 'honest', 'readers keep the accepted market');
  // Exactly a day ahead is accepted (clocks differ), and so is the market's next honest state after the refusal.
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: seconds + 86_400, commit: 'tomorrow' })).files;
  assert.equal((await refreshMarket(custom, options)).pointer.commit, 'tomorrow');
}));

test('a box whose own clock is wrong keeps its Market, and reads it again once the clock is right', withStore(async () => {
  const right = Date.parse('2026-11-18T12:00:00Z');
  const sites: Record<string, Map<string, Buffer>> = { [ADDRESS]: buildFixtureMarket(one({ commit: 'first' })).files };
  const hosts = fakeMarketHosts(sites);
  await refreshMarket(custom, { deps: hosts.deps, now: () => right });

  // The clock falls back to 2020 (a dead battery). The market publishes a new state.
  let now = Date.parse('2020-01-01T00:00:00Z');
  sites[ADDRESS] = buildFixtureMarket(one({ sequence: 1795000100, commit: 'second' })).files;
  await assert.rejects(refreshMarket(custom, { deps: hosts.deps, now: () => now }), refused(/If the date and time of this YouEye are wrong, correct them/));
  // Nothing is lost: the accepted market is listed as before, from the store.
  assert.equal((await readAcceptedMarket(custom))!.pointer.commit, 'first');
  assert.equal((await currentMarket(custom, { deps: hosts.deps, now: () => now })).pointer.commit, 'first');
  assert.equal((await marketSourceView(custom)).market!.commit, 'first');
  // The clock is set: the next refresh accepts the new state. Nothing had to be removed or added again.
  now = right + 600_000;
  assert.equal((await refreshMarket(custom, { deps: hosts.deps, now: () => now })).pointer.commit, 'second');
}));

// ─── F: the official lanes are not custom markets ─────────

test('a preview of the official lane this box does not follow is refused; its own lane and test markets are read', withStore(async () => {
  const built = buildFixtureMarket(one());
  const test = 'https://market.youeye.me/test/andrew/';
  const hosts = fakeMarketHosts({ [OFFICIAL_MARKET_ADDRESSES.main]: built.files, [OFFICIAL_MARKET_ADDRESSES.dev]: built.files, [test]: built.files });

  // No lane set: the box reads main (whatever its release channel).
  assert.equal((await previewMarket(OFFICIAL_MARKET_ADDRESSES.main, hosts.deps)).address, OFFICIAL_MARKET_ADDRESSES.main);
  hosts.take();
  await assert.rejects(previewMarket(OFFICIAL_MARKET_ADDRESSES.dev, hosts.deps), (error: unknown) => error instanceof MarketRefreshError && error.message === OFFICIAL_MARKET_AS_CUSTOM);
  await assert.rejects(previewMarket('https://market.youeye.me/dev/market.json', hosts.deps), refused(/This is the official YouEye Market; your YouEye already follows it/));
  // The owner chose dev: main is the other lane now.
  await setOfficialMarketLane('dev');
  await assert.rejects(previewMarket(OFFICIAL_MARKET_ADDRESSES.main, hosts.deps), refused(/official YouEye Market/));
  await assert.rejects(previewMarket('https://market.youeye.me./', hosts.deps), refused(/official YouEye Market/), 'the same lane under another spelling of its host');
  assert.equal(hosts.requests.length, 0, 'a refused lane is not fetched');
  assert.equal((await previewMarket(OFFICIAL_MARKET_ADDRESSES.dev, hosts.deps)).address, OFFICIAL_MARKET_ADDRESSES.dev);
  assert.equal((await previewMarket(test, hosts.deps)).address, test);
}));

// ─── G: pictures are fetched a few at a time ──────────────

test('pictures are fetched four at a time, three from one market; the others wait their turn or are told to come back', withStore(async () => {
  assert.deepEqual(PICTURE_FETCH_LIMITS, { all: 4, perSource: 3 });
  const picture = (n: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" id="p${n}"/>`);
  const apps = (prefix: string) => Array.from({ length: 6 }, (_, n) => ({ id: `${prefix}${n}`, pictures: { 'icon.svg': picture(prefix.length * 100 + n) } }));
  const friend = buildFixtureMarket(one({ apps: apps('a') }));
  const second = buildFixtureMarket(one({ apps: apps('bb') }));
  const other = customMarketSource('https://markets.example.org/second/', { id: 'custom-2', accepted_at: ACCEPTED_AT });
  let hold = false;
  let door = gate();
  const hosts = fakeMarketHosts({ [ADDRESS]: friend.files, [other.url]: second.files }, { before: (url) => (hold && /h\/files\//.test(url) ? door.held : undefined) });
  await refreshMarket(custom, { deps: hosts.deps });
  await refreshMarket(other, { deps: hosts.deps });
  hosts.take();
  const icons = (built: typeof friend, prefix: string) => Array.from({ length: 6 }, (_, n) => built.picturePaths[`${prefix}${n}`]['icon.svg']);
  const mine = icons(friend, 'a');
  const theirs = icons(second, 'bb');

  // Six pictures of one market at once: three requests are out, three wait.
  hold = true;
  const asked = mine.map((file) => readMarketPicture(custom, file, { deps: hosts.deps }));
  await pause(30);
  assert.equal(hosts.requests.length, 3, 'one market gets three places');
  // Another market still has the fourth place, and only that one.
  const others = theirs.slice(0, 2).map((file) => readMarketPicture(other, file, { deps: hosts.deps }));
  await pause(30);
  assert.equal(hosts.requests.length, 4, 'four requests in all');
  // A request that finds no place in time is told the box is busy, which is not a failure of the picture.
  await assert.rejects(readMarketPicture(other, theirs[2], { deps: hosts.deps, pictureWaitMs: 40 }),
    (error: unknown) => error instanceof Error && error.name === 'MarketBusyError' && (error as { retryAfterSeconds?: number }).retryAfterSeconds === 5);
  assert.equal(hosts.requests.length, 4, 'and causes no request');

  // The market answers: everyone who waited gets their picture, never more than four at a time.
  hold = false;
  door.open();
  door = gate();
  const answers = await Promise.all([...asked, ...others]);
  assert.deepEqual(answers.map((answer) => answer!.bytes.toString('utf8').match(/id="(p\d+)"/)![1]), ['p100', 'p101', 'p102', 'p103', 'p104', 'p105', 'p200', 'p201']);
  assert.equal(hosts.take().length, 8);
  // "Busy" was not remembered as a failure: the same picture is fetched now.
  assert.deepEqual((await readMarketPicture(other, theirs[2], { deps: hosts.deps }))!.bytes, picture(202));
  // Pictures the box already holds need no place at all.
  hold = true;
  const waiting = [3, 4, 5].map((n) => readMarketPicture(other, theirs[n], { deps: hosts.deps }));
  await pause(20);
  assert.deepEqual((await readMarketPicture(custom, mine[0], { deps: hosts.deps }))!.bytes, picture(100));
  hold = false;
  door.open();
  await Promise.all(waiting);
}));
