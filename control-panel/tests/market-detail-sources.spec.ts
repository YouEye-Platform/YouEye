/**
 * Plan 11 C6, C8, C9, C10 (the visible part): an app that needs a newer YouEye says so instead of Install; an installed
 * app shows where it takes its updates from (recorded, apart from the catalog entry shown) and why it gets none; the
 * detail page names the other markets that carry the same app; the sources page shows each market's own words and
 * state.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as routing from '../src/lib/market/update-routing';
import { OFFICIAL_MARKET_ADDRESSES } from '../src/lib/market/source';
import { buildFixtureMarket } from './fixtures/market';
import { load, marketWorld, root, withMarketState } from './fixtures/market-world';

const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const english = JSON.parse(read('messages/en.json')).interface as Record<string, string>;
/** The source shows this English text through the message catalogue (ids are `m` + 12 hex of its sha256). */
function shows(source: string, text: string) {
  const id = `m${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  assert.equal(english[id], text, `messages/en.json has ${id}`);
  assert.ok(source.includes(`translateInterface("${id}"`) || source.includes(`translateInterface('${id}'`), `the source shows “${text}”`);
}
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

const OFFICIAL = OFFICIAL_MARKET_ADDRESSES.main;
const FRIEND = 'https://markets.example.org/friend/';

function seedSources(directory: string) {
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true },
    { id: 'friend', name: 'Friend', url: FRIEND, enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
}

const sites = () => ({
  [OFFICIAL]: buildFixtureMarket({ sequence: 1795000000, commit: 'official1', apps: [
    { id: 'demo', version: '1.0.0' },
    { id: 'future', version: '9.0.0', entry: { requires: { youeye: '>=99.0.0' } } },
  ] }).files,
  [FRIEND]: buildFixtureMarket({ sequence: 1795000000, commit: 'friend01', apps: [{ id: 'demo', version: '2.0.0' }] }).files,
});

interface Installed { metadata?: Record<string, unknown> | null; record?: Record<string, unknown> | null }

function detailRoute(installed: Record<string, Installed> = {}) {
  const world = marketWorld(sites(), { boxVersion: '0.6.11' });
  const route = load('src/app/api/market/app/[appId]/route.ts', {
    'next/server': { NextResponse: { json } },
    '@/lib/market/catalog': world.catalog,
    '@/lib/market/direct-apps': {
      directMarketAppToMarketApp: () => { throw new Error('no Added apps here'); },
      getDirectMarketApp: async () => null,
      listDirectMarketAppViews: async () => [],
    },
    '@/lib/market/installed-apps': { getInstalledApp: async (id: string) => installed[id]?.record ?? null },
    '@/lib/market/market-store': world.store,
    '@/lib/market/metadata': { readInstallMetadata: async (id: string) => installed[id]?.metadata ?? null },
    '@/lib/market/source': world.sources,
    '@/lib/market/update-routing': routing,
  });
  const get = async (appId: string, source?: string) => {
    const url = new URL(`https://control.example.test/api/market/app/${appId}${source ? `?source=${source}` : ''}`);
    const answer = await route.GET(Object.assign(new Request(url), { nextUrl: url }), { params: Promise.resolve({ appId }) });
    return { status: answer.status, body: await answer.json() };
  };
  return { get, world };
}

test('the detail API names the other markets with the same app, and the shown one by ?source=', withMarketState(async (directory) => {
  seedSources(directory);
  const { get } = detailRoute();
  const official = await get('demo');
  assert.equal(official.status, 200);
  assert.equal(official.body.app.sourceId, 'official');
  assert.equal(official.body.app.version, '1.0.0');
  assert.deepEqual(official.body.variants, [{ sourceId: 'friend', sourceName: 'Friend', version: '2.0.0' }]);
  assert.equal(official.body.installed, null, 'not installed');

  const friend = await get('demo', 'friend');
  assert.equal(friend.body.app.sourceId, 'friend');
  assert.equal(friend.body.app.version, '2.0.0');
  assert.deepEqual(friend.body.variants.map((variant: { sourceId: string }) => variant.sourceId), ['official']);
}));

test('an app that needs a newer YouEye is listed with what it needs', withMarketState(async (directory) => {
  seedSources(directory);
  const { get } = detailRoute();
  const future = await get('future');
  assert.equal(future.status, 200);
  assert.equal(future.body.app.installBlocked.code, 'requires-newer-youeye');
  assert.equal(future.body.app.needsYouEye, '99.0.0');
  assert.equal(future.body.app.version, '9.0.0');
}));

test('an installed app carries where it takes its updates from, as recorded, apart from the entry shown', withMarketState(async (directory) => {
  seedSources(directory);
  const blocked = { code: 'source-not-accepted', message: 'Market source "Friend" is not accepted' };
  const { get } = detailRoute({
    demo: {
      metadata: { appId: 'demo', catalogKey: 'friend:app:demo', sourceId: 'friend', sourceName: 'Friend', sourceRepoUrl: FRIEND, installedVersion: '2.0.0' },
      record: { appId: 'demo', sourceId: 'friend', installedVersion: '2.0.0', updateBlocked: blocked },
    },
  });
  const shown = await get('demo');
  assert.equal(shown.body.app.sourceId, 'official', 'the page shows the official entry');
  assert.deepEqual(shown.body.installed, {
    sourceId: 'friend', sourceName: 'Friend', sourceAddress: FRIEND, version: '2.0.0', updateBlocked: blocked,
  });
}));

test('an app installed from the official Market follows the address the box reads it from', withMarketState(async (directory) => {
  seedSources(directory);
  const { get } = detailRoute({
    demo: { metadata: { appId: 'demo', catalogKey: 'official:app:demo', sourceId: 'official', installedVersion: '1.0.0' }, record: null },
  });
  const shown = await get('demo', 'friend');
  assert.equal(shown.body.installed.sourceId, 'official');
  assert.equal(shown.body.installed.sourceName, 'Official YouEye Market');
  assert.equal(shown.body.installed.sourceAddress, OFFICIAL);
  assert.equal(shown.body.installed.updateBlocked, null);
}));

test('an app whose source went away still says where it came from', withMarketState(async (directory) => {
  seedSources(directory);
  const gone = { code: 'source-unavailable', message: 'Market source "andrew-test" is not configured: this app has no update source.' };
  const { get } = detailRoute({
    demo: {
      metadata: { appId: 'demo', sourceId: 'andrew-test', sourceName: 'Andrew', sourceRepoUrl: 'https://git.example.org/andrew/market', installedVersion: '0.9.0' },
      record: { appId: 'demo', sourceId: 'andrew-test', installedVersion: '0.9.0', updateBlocked: gone },
    },
  });
  const shown = await get('demo');
  assert.equal(shown.body.installed.sourceId, 'andrew-test');
  assert.equal(shown.body.installed.updateBlocked.code, 'source-unavailable');
  // Both markets on the box are offered by Change.
  assert.equal(shown.body.app.sourceId, 'official');
  assert.deepEqual(shown.body.variants.map((variant: { sourceId: string }) => variant.sourceId), ['friend']);
}));

test('an unknown app is a 404', withMarketState(async (directory) => {
  seedSources(directory);
  const { get } = detailRoute();
  assert.equal((await get('nothing')).status, 404);
  assert.equal((await get('demo', 'nowhere')).status, 404);
}));

test('the update-blocked reason reaches the Market, Settings and the dashboard', () => {
  assert.match(read('src/lib/market/types.ts'), /updateBlocked\?: UpdateBlocked \| null;/);
  assert.match(read('src/app/api/market/status/route.ts'), /updateBlocked = dbApp\.updateBlocked \?\? null;/);
  assert.match(read('src/app/api/apps/unified/route.ts'), /updateBlocked: dbEntry\?\.updateBlocked \?\? null/);
  const bridge = read('src/app/api/ui-bridge/apps/route.ts');
  assert.equal(bridge.match(/updateBlocked: dbEntry\?\.updateBlocked \?\? null/g)?.length, 2);

  const note = read('src/components/market/update-blocked.tsx');
  shows(note, 'No update source: the market this app came from is no longer on this box.');
  shows(note, 'Choose another market with Change.');
  shows(note, 'No updates: you have not accepted the market this app comes from.');
  shows(note, 'The new version of this app needs a newer YouEye.');
  assert.match(note, /case 'source-changed':\s*default:[\s\S]*text: blocked\.message/);
  shows(note, 'Needs YouEye {version} or newer');
  shows(note, 'Needs a newer YouEye');
  shows(note, 'Update YouEye in Settings to install this app.');

  const settings = read('src/components/settings-shell/apps-client.tsx');
  assert.match(settings, /blockedApps = apps\.filter\(\(app\) => app\.category === "user" && !!app\.updateBlocked/);
  assert.match(settings, /<UpdateBlockedNote blocked=\{app\.updateBlocked!\} appId=\{app\.id\}/);
  const embed = read('src/app/embed/apps/client.tsx');
  assert.match(embed, /app\.updateBlocked && !app\.updateAvailable/);
  assert.match(embed, /target="_blank" rel="noopener noreferrer"/);
});

test('an app this box cannot install shows what it needs instead of Install, and gets no install form', () => {
  const detail = read('src/app/market/[appId]/page.tsx');
  // The one action in the header: no Install button for a blocked app, and the notice says what it needs.
  assert.match(detail, /\) : app\.installBlocked \? null : \(\s*<>\s*<Button className="rounded-full px-7" onClick=\{\(\) => setShowInstallDialog\(true\)\}/);
  assert.match(detail, /!thisInstall && !isInstalled && app\.installBlocked && <div className="mt-5"><InstallBlockedNotice app=\{app\} \/><\/div>/);
  assert.match(detail, /showInstallDialog && !app\.installBlocked &&/);
  assert.match(read('src/components/market/install-dialog.tsx'), /if \(props\.app\.installBlocked\) return null;/);
  // Market cards say why instead of offering the app as installable.
  assert.match(read('src/components/market/market-parts.tsx'), /const blocked = installed \? null : installBlockedLabel\(translateInterface, app\);/);
  const home = read('src/app/market/page.tsx');
  // One card per app id, the official Market's first.
  assert.match(home, /sort\(\(a, b\) => Number\(a\.sourceId !== 'official'\) - Number\(b\.sourceId !== 'official'\)\)/);
  assert.match(home, /const key = `\$\{app\.itemKind \|\| 'app'\}:\$\{app\.id\}`;/);
});

test('the detail page offers other markets; Settings changes the update source with the owner and their consent', () => {
  const detail = read('src/app/market/[appId]/page.tsx');
  shows(detail, 'Also available from {source}');
  assert.match(detail, /\?source=\$\{encodeURIComponent\(variant\.sourceId\)\}/);
  // The Market is a store now: changing an installed app's update source lives in Settings → Apps.
  assert.doesNotMatch(detail, /\/source`, \{/);
  const manage = read('src/components/market/app-management.tsx');
  shows(manage, 'Updates from');
  assert.match(manage, /authenticatedFetch\(`\/api\/market\/app\/\$\{encodeURIComponent\(appId\)\}\/source`, \{\s*method: 'PATCH'/);
  // An unaccepted market or one whose version needs a newer YouEye cannot be chosen; an Added app needs the tick.
  assert.match(manage, /disabled=\{switching !== null \|\| !!blocked \|\| \(direct && consent\[variant\.sourceId\] !== true\)\}/);
  assert.match(manage, /acceptUnverifiedPublisher: agreed, allowSetup: agreed/);
  // Nothing switches by itself: the PATCH is only in the click handler.
  assert.equal(manage.match(/\/source`, \{/g)?.length, 1);
  assert.match(manage, /onClick=\{\(\) => switchTo\(variant\)\}/);
  assert.match(read('src/components/settings-shell/apps-client.tsx'), /<AppUpdateSource appId=\{appId\}/);
});

test('the sources page shows each market’s own words and state, adds by preview and tick, and lists removed git sources', () => {
  const page = read('src/app/market/sources/page.tsx');
  assert.match(page, /authenticatedFetch\(`\/api\/market\/add\/preview\?market=\$\{encodeURIComponent\(newUrl\.trim\(\)\)\}`, \{ method: 'POST'/);
  assert.match(page, /body: JSON\.stringify\(\{ url: preview\.address, name: newName\.trim\(\) \|\| undefined, acceptRisk: true \}\)/);
  assert.match(page, /disabled=\{!acceptRisk \|\| saving\}/);
  shows(page, 'Apps from this source are not checked by YouEye. They run their own setup steps on your box. Add only sources you trust.');
  shows(page, 'I trust this source');
  shows(page, 'The market calls itself “{name}”, published by “{publisher}”.');
  shows(page, 'This box follows {address}');
  assert.match(page, /s\.market\.commit\?\.slice\(0, 8\), when\(s\.market\.sequence_date\)/);
  shows(page, 'Last refreshed {time}');
  assert.match(page, /authenticatedFetch\('\/api\/market\/source\/refresh'/);
  assert.match(page, /authenticatedFetch\('\/api\/market\/source\/accept'/);
  shows(page, 'These sources were read from a Git repository, which YouEye no longer supports: {sources}. Add the market’s address again.');
  assert.match(page, /dismiss_removed_sources: true/);
  const preview = read('src/components/market/market-preview.tsx');
  shows(preview, 'In the market’s own words');
  assert.doesNotMatch(preview + page, /dangerouslySetInnerHTML/);
});
