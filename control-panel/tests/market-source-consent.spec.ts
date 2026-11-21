/**
 * Plan 10 Part D, on markets read by address (Plan 11): nothing from a custom market or a URL installs, updates or
 * takes over an app without the owner's consent, the official Market is the default wherever no source is named,
 * and an app follows the market address it was installed from, never just a source id.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import * as format from '../src/lib/market/market-format';
import * as realSources from '../src/lib/market/source';
import * as routing from '../src/lib/market/update-routing';
import * as urlApp from '../src/lib/market/url-app';
import * as version from '../src/lib/version';
import { OFFICIAL_MARKET_ADDRESSES } from '../src/lib/market/source';
import { appFixture } from './fixtures/app-format';
import { buildFixtureMarket } from './fixtures/market';
import { load, marketWorld, root, withMarketState } from './fixtures/market-world';
import { freeLifecycle } from './fixtures/free-lifecycle';

const nodeRequire = createRequire(import.meta.url);

/**
 * The real source module over the test's temporary state directory. `installed` are the installed apps it sees
 * (their recorded source ids); `writes` collects the temporary files of its writes of the source list.
 */
function sourceModule(seen: { installed?: () => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>; writes?: string[] } = {}) {
  const fsp = nodeRequire('node:fs/promises');
  return load('src/lib/market/source.ts', {
    'fs/promises': { ...fsp, rename: (from: string, to: string) => { seen.writes?.push(from); return fsp.rename(from, to); } },
    './market-format': format,
    './update-routing': routing,
    './url-app': urlApp,
    './installed-apps': { getAllInstalledApps: async () => seen.installed?.() ?? [] },
  });
}

const withDirectory = withMarketState;

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const next = { NextResponse: { json } };
const session = async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } });
const admin = { requireAdmin: session, requireAdminCsrf: session };
const request = (body: unknown, url = 'https://cp.example.test/api') =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const SETUP_A = stringify({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/health' } }] });
const SETUP_B = stringify({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/ready' } }] });

// Three sources: the official one, a custom market added before consent existed (first by priority, never accepted)
// and a custom market the owner accepted.
const OFFICIAL = OFFICIAL_MARKET_ADDRESSES.main;
const LEGACY = 'https://markets.example.org/stranger/';
const TRUSTED = 'https://markets.example.org/friend/';
const FOREIGN = 'https://markets.example.org/foreign/';
function seedSources(directory: string) {
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true },
    { id: 'legacy', name: 'Stranger', url: LEGACY, enabled: true, priority: 1 },
    { id: 'trusted', name: 'Friend', url: TRUSTED, enabled: true, priority: 2, accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
}

const market = (demo: string, bundle = true) => buildFixtureMarket({
  sequence: 1795000000, commit: `demo-${demo}`,
  apps: [{ id: 'demo', version: demo }], bundles: bundle ? [{ id: 'pair', members: ['demo'] }] : [],
}).files;

/** The markets of this file: the official one has demo 1.0.0, the stranger's 3.0.0, the friend's 2.0.0, a foreign one 4.0.0. */
const marketSites = () => ({ [OFFICIAL]: market('1.0.0', false), [LEGACY]: market('3.0.0'), [TRUSTED]: market('2.0.0'), [FOREIGN]: market('4.0.0') });

/** The real store and catalog reader over those markets and the given source module. */
function worldOf(sources: Record<string, any>, now?: () => number) {
  return marketWorld(marketSites(), { sources, boxVersion: '99.0.0', now });
}
const catalogModule = (sources: Record<string, any>) => worldOf(sources).catalog;

function sourceRoutes(sources: Record<string, any>, world = worldOf(sources)) {
  const route = load('src/app/api/market/source/route.ts', {
    'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
    '@/lib/market/market-store': world.store,
    '@/lib/market/catalog': { clearCatalogCache() {} },
  });
  const accept = load('src/app/api/market/source/accept/route.ts', {
    'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
    '@/lib/market/catalog': { clearCatalogCache() {} },
  });
  const refresh = load('src/app/api/market/source/refresh/route.ts', {
    'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources, '@/lib/market/market-store': world.store,
  });
  const patch = (body: unknown) => route.PATCH(new Request('https://cp.example.test/api', { method: 'PATCH', body: JSON.stringify(body) }));
  return { route, accept, refresh, world, patch };
}

// ─── D1: consent is recorded by the server only ──────────────────────────────

test('a market is added only with acceptRisk and only when it is a market; the list edit cannot add, accept or keep an accepted market re-pointed',
  withDirectory(async () => {
    const sources = sourceModule();
    const { route, accept, world, patch } = sourceRoutes(sources);
    const list = async () => (await sources.getConfiguredMarketSources()) as Array<Record<string, any>>;

    const refused = await route.POST(request({ url: TRUSTED }));
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /not checked by YouEye/);
    assert.equal((await route.POST(request({ repo_url: TRUSTED, acceptRisk: true }))).status, 400, 'the address field is `url`');
    assert.deepEqual((await list()).map((source) => source.id), ['official']);
    assert.equal(world.hosts.requests.length, 0, 'nothing is asked before the owner agreed');

    // An address that is not a market adds nothing; neither does one that is not public.
    const nothing = await route.POST(request({ url: 'https://markets.example.org/nothing/', acceptRisk: true }));
    assert.equal(nothing.status, 400);
    assert.match((await nothing.json()).error, /market\.json: HTTP 404/);
    for (const url of ['http://markets.example.org/friend/', 'https://192.168.1.5/market/', 'https://box.local/market/', 'https://user:pw@markets.example.org/friend/', 'not a url']) {
      assert.equal((await route.POST(request({ url, acceptRisk: true }))).status, 400, url);
    }
    assert.deepEqual((await list()).map((source) => source.id), ['official']);

    // Added by its market.json or its folder: one address either way, accepted at once, its apps in the store.
    const added = await route.POST(request({ url: `${TRUSTED}market.json`, id: 'andrew-test', acceptRisk: true }));
    assert.equal(added.status, 200);
    const answer = await added.json();
    assert.equal(answer.source.url, TRUSTED);
    assert.equal(answer.source.name, 'markets.example.org', 'without a name from the owner, the host');
    assert.equal(answer.source.market.name, 'Test Market', 'what the market calls itself is kept apart');
    assert.equal(answer.source.market.apps, 1);
    assert.equal(answer.source.market.commit, 'demo-2.0.0');
    assert.equal(answer.source.refresh_error, undefined);
    const [, andrew] = await list();
    assert.equal(andrew.id, 'andrew-test');
    assert.equal(andrew.kind, 'url');
    assert.match(andrew.accepted_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await route.POST(request({ url: TRUSTED.slice(0, -1), acceptRisk: true }))).status, 400, 'the same market twice');

    // The PATCH cannot create a source, accepted or not.
    const create = await patch({ active_sources: [...await list(), { id: 'evil', url: LEGACY, accepted_at: '2026-01-01T00:00:00Z' }] });
    assert.equal(create.status, 400);
    assert.match((await create.json()).error, /does not exist/);
    assert.deepEqual((await list()).map((source) => source.id), ['official', 'andrew-test']);

    // A market from before consent existed: the PATCH cannot accept it; the accept call can.
    writeFileSync(path.join(process.env.YOUEYE_MARKET_STATE_DIR!, 'market-sources.json'), JSON.stringify({ active_sources: [
      ...(await list()).map((source) => ({ ...source })),
      { id: 'legacy', name: 'Stranger', url: LEGACY, enabled: true, priority: 5 },
    ] }));
    assert.equal((await patch({ active_sources: (await list()).map((source) => ({ ...source, accepted_at: '2026-01-01T00:00:00Z' })) })).status, 200);
    assert.equal((await list()).find((source) => source.id === 'legacy')!.accepted_at, undefined);

    // Enable, disable and reorder keep the acceptance; a new address under the same id drops it.
    const toggled = await patch({ active_sources: (await list()).map((source) => ({ ...source, enabled: source.id !== 'official' })) });
    assert.equal(toggled.status, 200);
    assert.equal((await list()).find((source) => source.id === 'official')!.enabled, false);
    assert.ok((await list()).find((source) => source.id === 'andrew-test')!.accepted_at);
    await patch({ active_sources: (await list()).map((source) => source.id === 'andrew-test' ? { ...source, url: FOREIGN } : source) });
    const retargeted = (await list()).find((source) => source.id === 'andrew-test')!;
    assert.equal(retargeted.url, FOREIGN);
    assert.equal(retargeted.accepted_at, undefined, 'address change');
    assert.equal((await patch({ active_sources: (await list()).map((source) => source.id === 'andrew-test' ? { ...source, url: LEGACY } : source) })).status, 400,
      'two sources cannot share an address');
    // Removing works; the official source is always kept; the removed market's copy goes with it.
    await patch({ active_sources: (await list()).filter((source) => source.id === 'legacy') });
    assert.deepEqual((await list()).map((source) => source.id).sort(), ['legacy', 'official']);
    assert.equal(await world.store.readAcceptedMarket({ id: 'andrew-test', kind: 'url', url: TRUSTED }), null);

    assert.equal((await accept.POST(request({ id: 'legacy' }))).status, 200);
    assert.ok((await list()).find((source) => source.id === 'legacy')!.accepted_at);
    assert.equal((await accept.POST(request({ id: 'official' }))).status, 400);
    assert.equal((await accept.POST(request({ id: 'nope' }))).status, 404);
  }));

// ─── D2/D3: one rule, official by default ────────────────────────────────────

test('installs resolve the official Market by default and never an unaccepted source', withDirectory(async (directory) => {
  seedSources(directory);
  const sources = sourceModule();
  const catalog = catalogModule(sources);

  // "legacy" is the first enabled custom source by priority; without a named source the official Market still wins.
  const byDefault = await catalog.resolveCatalogApp('demo');
  assert.equal(byDefault.source.id, 'official');
  assert.equal(byDefault.manifest.version, '1.0.0');
  await assert.rejects(catalog.resolveCatalogApp('demo', 'legacy'),
    (error: any) => error.code === 'source-not-accepted' && /not accepted/.test(error.message));
  const trusted = await catalog.resolveCatalogApp('demo', 'trusted');
  assert.equal(trusted.source.id, 'trusted');
  assert.equal(trusted.manifest.version, '2.0.0');
  assert.equal(trusted.reference.repo, TRUSTED);
  await assert.rejects(catalog.resolveCatalogApp('demo', 'missing'), (error: any) => error.code === 'source-unavailable');

  // With the official Market turned off, the first enabled source is a custom one: it is still never the default.
  const list = await sources.getConfiguredMarketSources();
  await sources.updateMarketSourceList(list.map((source: any) => ({ ...source, enabled: source.id !== 'official' })));
  await assert.rejects(catalog.resolveCatalogApp('demo'), (error: any) => error.code === 'source-unavailable' && /turned off/.test(error.message));
  await sources.updateMarketSourceList(list);

  // Listing stays allowed, with the reason attached.
  const apps = await catalog.fetchAvailableApps();
  assert.deepEqual(apps.map((app: any) => [app.sourceId, app.sourceNotAccepted ?? false, app.sourceRepoUrl]).sort(),
    [['legacy', true, LEGACY], ['official', false, undefined], ['trusted', false, TRUSTED]]);
  const bundles = await catalog.fetchBundles();
  assert.deepEqual(bundles.map((bundle: any) => [bundle.sourceId, bundle.sourceNotAccepted ?? false]), [['legacy', true]]);
  assert.equal(await catalog.fetchBundle('pair'), null, 'a bundle without a named source is the official one');
  assert.equal((await catalog.fetchBundle('pair', 'legacy')).sourceId, 'legacy');
  assert.equal((await catalog.fetchBundle('pair', 'trusted')).sourceId, 'trusted', 'a named source answers for itself');
}));

function installRoute(catalog: Record<string, any>, sources: Record<string, any>, direct: unknown = null) {
  const installs: any[] = [];
  const route = load('src/app/api/market/install/route.ts', {
    'next/server': {},
    '@/lib/market/catalog': catalog,
    '@/lib/market/source': sources,
    '@/lib/market/engine': { installApp: async (_manifest: unknown, config: unknown) => { installs.push(config); } },
    '@/lib/market/install-tracker': {
      startTracking: () => new AbortController(), trackEvent() {}, finishTracking() {}, logOperationFailure() {},
      sanitiseInstallEvent: (event: unknown) => event, sensitivitySafeInstallError: () => 'failed',
    },
    '@/lib/market/update-admission': freeLifecycle,
    '@/lib/health/notification-bridge': { sendNotificationToUI: async () => {} },
    '@/lib/events/emitter': { emitEvent() {} },
    '@/lib/settings': { settingsService: { getRaw: async () => ({ domain: 'box.example.test' }) } },
    '@/lib/health/issues': { hasOpenCriticalIssue: async () => null },
    '@/lib/auth/rbac': admin,
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/admission/management': { admissionAdministrator: async () => '20000000-0000-4000-8000-000000000001' },
    '@/lib/identity/store': {},
    '@/lib/market/install-ai-settings': {},
    '@/lib/market/direct-apps': { getDirectMarketApp: async () => direct },
    '@/lib/market/installed-apps': { updateInstalledAppSource: async () => {} },
  });
  return { installs, post: async (body: unknown) => {
    const response = await route.POST(request(body));
    if (response.headers.get('content-type')?.includes('event-stream')) await response.text();
    return response;
  } };
}

test('the install route: official by default, an unaccepted source refused, the source identity set by the server',
  withDirectory(async (directory) => {
    seedSources(directory);
    const sources = sourceModule();
    const { installs, post } = installRoute(catalogModule(sources), sources);

    assert.equal((await post({ appId: 'demo', sourceName: 'Evil', catalogKey: 'legacy:app:demo', sourceRepoUrl: LEGACY,
      manifestRepo: LEGACY, manifestBranch: 'evil', manifestDigest: 'sha256:evil' })).status, 200);
    assert.equal(installs[0].sourceId, 'official');
    assert.equal(installs[0].catalogKey, 'official:app:demo');
    assert.equal(installs[0].sourceName, 'Official YouEye Market');
    assert.equal(installs[0].sourceRepoUrl, undefined);
    assert.equal(installs[0].manifestPath, 'apps/demo/youeye-app.yaml');
    assert.equal(installs[0].manifestRepo, OFFICIAL);
    assert.equal(installs[0].manifestBranch, 'demo-1.0.0');
    assert.match(installs[0].manifestDigest, /^sha256:[0-9a-f]{64}$/);

    const refused = await post({ appId: 'demo', sourceId: 'legacy' });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'source-not-accepted');
    assert.equal(installs.length, 1);

    assert.equal((await post({ appId: 'demo', sourceId: 'trusted' })).status, 200);
    assert.equal(installs[1].sourceId, 'trusted');
    assert.equal(installs[1].sourceRepoUrl, TRUSTED);
    assert.equal(installs[1].manifestRepo, TRUSTED);
  }));

test('an app added by URL installs only with its own flags', withDirectory(async () => {
  const sources = sourceModule();
  const manifest = appFixture({}, { 'setup/install.yaml': SETUP_A });
  const direct = { sourceId: 'direct:abc', manifestUrl: 'https://apps.example.test/demo/youeye-app.yaml', manifestDigest: 'sha256:x', manifest };
  const { installs, post } = installRoute({}, sources, direct);
  const untrusted = await post({ appId: 'demo', sourceId: 'direct:abc' });
  assert.equal(untrusted.status, 403);
  assert.equal((await untrusted.json()).code, 'publisher-not-trusted');
  const noSetup = await post({ appId: 'demo', sourceId: 'direct:abc', acceptUnverifiedPublisher: true });
  assert.equal(noSetup.status, 403);
  assert.deepEqual((await noSetup.json()).setups, [{ name: 'setup/install.yaml', for: 'install' }]);
  assert.equal(installs.length, 0);
  assert.equal((await post({ appId: 'demo', sourceId: 'direct:abc', acceptUnverifiedPublisher: true, allowSetup: true })).status, 200);
  assert.equal(installs[0].sourceName, 'Added');
}));

// ─── Bundles ─────────────────────────────────────────────────────────────────

test('a bundle installs its members from its own accepted source and records it', withDirectory(async (directory) => {
  seedSources(directory);
  const sources = sourceModule();
  const catalog = catalogModule(sources);
  const installs: any[] = [];
  const installer = load('src/lib/market/bundle-installer.ts', {
    './engine': { installApp: async (_manifest: unknown, config: unknown) => { installs.push(config); } },
    './install-tracker': { logOperationFailure() {}, sanitiseInstallEvent: (event: unknown) => event, sensitivitySafeInstallError: () => 'failed' },
    './catalog': catalog,
    './metadata': { listInstalledApps: async () => [] },
    '../settings': { settingsService: { getRaw: async () => ({ domain: 'box.example.test' }) } },
  });
  const bundle = (sourceId?: string) => ({ id: 'pair', name: 'Pair', description: 'd', members: ['demo'], connections: [], storageGroups: [], sourceId });

  const official = await installer.installBundle(bundle(), () => {});
  assert.equal(official.members[0].status, 'installed');
  assert.equal(installs[0].sourceId, 'official');
  assert.equal(installs[0].publicAccess, false);
  await installer.installBundle(bundle('trusted'), () => {});
  assert.equal(installs[1].sourceId, 'trusted');
  assert.equal(installs[1].catalogKey, 'trusted:app:demo');
  assert.equal(installs[1].sourceRepoUrl, TRUSTED);
  const legacy = await installer.installBundle(bundle('legacy'), () => {});
  assert.equal(legacy.members[0].status, 'failed');
  assert.equal(installs.length, 2);

  const route = load('src/app/api/market/bundles/[id]/install/route.ts', {
    'next/server': {}, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
    '@/lib/market/catalog': { fetchBundle: async () => { throw new Error('must not be read'); } },
    '@/lib/market/update-admission': {}, '@/lib/market/bundle-installer': {}, '@/lib/market/install-tracker': {},
  });
  const response = await route.POST({ nextUrl: new URL('https://cp.example.test/api/market/bundles/pair/install?source=legacy') },
    { params: Promise.resolve({ id: 'pair' }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'source-not-accepted');
}));

// ─── D4: the source switch ───────────────────────────────────────────────────

const lifecycleBusy = load('src/lib/http/lifecycle-busy.ts', {
  'next/server': next,
  '@/lib/market/update-admission': { AppLifecycleBusyError: class extends Error {} },
  '@/lib/incus/app-network-ipam': { AppNetworkLockBusyError: class extends Error {} },
});

/** The switch route's lock modules; `lifecycle` stands in for the app lifecycle lock. */
function switchLocks(lifecycle: (appId: string, work: () => unknown) => unknown = (_appId, work) => work()) {
  return {
    '@/lib/market/update-admission': { ...freeLifecycle, withAppLifecycle: lifecycle },
    '@/lib/http/lifecycle-busy': lifecycleBusy,
    '@/lib/market/install-tracker': { logOperationFailure() {} },
  };
}

test('switching an installed app to another source needs the same consent as installing from it', withDirectory(async (directory) => {
  seedSources(directory);
  const sources = sourceModule();
  let metadata: Record<string, any> = { appId: 'demo', integration: 'basic', sourceId: 'official', manifestDigest: 'sha256:installed',
    manifestRepo: OFFICIAL, manifestBranch: 'demo-1.0.0', installedVersion: '1.0.0', subdomain: 'demo' };
  const saved: any[] = [];
  const sourceUpdates: any[] = [];
  const manifest = appFixture({}, { 'setup/install.yaml': SETUP_A });
  const route = load('src/app/api/market/app/[appId]/source/route.ts', {
    'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
    '@/lib/market/catalog': catalogModule(sources),
    '@/lib/market/direct-apps': { getDirectMarketApp: async () => ({ sourceId: 'direct:abc', manifestUrl: 'https://apps.example.test/y.yaml', manifest }) },
    '@/lib/market/metadata': { readInstallMetadata: async () => structuredClone(metadata), saveInstallMetadata: async (value: any) => { saved.push(value); metadata = value; } },
    '@/lib/market/installed-apps': { upsertInstalledApp: async () => {}, updateInstalledAppSource: async (...args: unknown[]) => { sourceUpdates.push(args); } },
    ...switchLocks(),
  });
  const patch = (body: unknown) => route.PATCH(new Request('https://cp.example.test/api', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ appId: 'demo' }) });

  assert.equal((await patch({ sourceId: 'legacy' })).status, 403);
  assert.equal(saved.length, 0);
  assert.equal((await patch({ sourceId: 'direct:abc' })).status, 403);
  assert.equal((await patch({ sourceId: 'direct:abc', acceptUnverifiedPublisher: true })).status, 403, 'setup files need allowSetup');
  assert.equal(saved.length, 0);

  assert.equal((await patch({ sourceId: 'trusted' })).status, 200);
  assert.equal(metadata.sourceId, 'trusted');
  assert.equal(metadata.catalogKey, 'trusted:app:demo');
  assert.equal(metadata.sourceRepoUrl, TRUSTED, 'the switch records the market address the app follows from now on');
  assert.equal(metadata.manifestDigest, 'sha256:installed', 'the installed copy is unchanged until the next update');
  assert.equal(metadata.manifestRepo, OFFICIAL, 'and so is where it was read from');
  assert.equal((await patch({ sourceId: 'direct:abc', acceptUnverifiedPublisher: true, allowSetup: true })).status, 200);
  assert.equal(metadata.sourceId, 'direct:abc');
  assert.deepEqual(sourceUpdates.at(-1), ['demo', 'url', 'https://apps.example.test/y.yaml']);
}));

test('the source switch saves inside the app lock over the record it reads there, and answers busy with 409',
  withDirectory(async (directory) => {
    seedSources(directory);
    const sources = sourceModule();
    let metadata: Record<string, any> = { appId: 'demo', integration: 'basic', sourceId: 'official', installedVersion: '1.0.0', subdomain: 'demo' };
    let busy = false;
    const route = load('src/app/api/market/app/[appId]/source/route.ts', {
      'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
      '@/lib/market/catalog': catalogModule(sources),
      '@/lib/market/direct-apps': {},
      '@/lib/market/metadata': { readInstallMetadata: async () => structuredClone(metadata), saveInstallMetadata: async (value: any) => { metadata = value; } },
      '@/lib/market/installed-apps': { upsertInstalledApp: async () => {}, updateInstalledAppSource: async () => {} },
      ...switchLocks(async (_appId, work) => {
        if (busy) throw Object.assign(new Error('busy'), { name: 'AppLifecycleBusyError' });
        // An update commits while the target was being resolved: the switch must keep what it wrote.
        metadata = { ...metadata, installedVersion: '1.5.0', manifestDigest: 'sha256:updated' };
        return work();
      }),
    });
    const patch = (body: unknown) => route.PATCH(new Request('https://cp.example.test/api', { method: 'PATCH', body: JSON.stringify(body) }),
      { params: Promise.resolve({ appId: 'demo' }) });

    assert.equal((await patch({ sourceId: 'trusted' })).status, 200);
    assert.equal(metadata.sourceId, 'trusted');
    assert.equal(metadata.installedVersion, '1.5.0', 'the update committed meanwhile is not overwritten');
    assert.equal(metadata.manifestDigest, 'sha256:updated');
    assert.equal(metadata.sourceRepoUrl, TRUSTED);

    busy = true;
    const refused = await patch({ sourceId: 'official' });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'operation_in_progress');
    assert.equal(metadata.sourceId, 'trusted');
  }));

// ─── An app follows its source's market address, not just its id ────────────

/**
 * App "demo" 1.0.0 installed from `installedFrom` under source id `sourceId`, with the real source list, store,
 * catalog, update check, updater, source routes and source switch route over it.
 */
function addressScenario(directory: string, installedFrom: { sourceId: string; sourceName: string; address: string } = { sourceId: 'custom-1', sourceName: 'Friend', address: TRUSTED }) {
  mkdirSync(path.join(directory, 'state'), { recursive: true, mode: 0o700 });
  let metadata: Record<string, any> = { appId: 'demo', integration: 'basic', itemKind: 'app', lifecycleState: 'active',
    sourceId: installedFrom.sourceId, sourceName: installedFrom.sourceName, catalogKey: `${installedFrom.sourceId}:app:demo`, sourceRepoUrl: installedFrom.address,
    manifestPath: 'apps/demo/youeye-app.yaml', manifestRepo: installedFrom.address, manifestBranch: 'main',
    manifestDigest: 'sha256:installed', installedVersion: '1.0.0', subdomain: 'demo', serviceCredentialState: 'ready', containers: [] };
  const metadataModule = {
    readInstallMetadata: async () => structuredClone(metadata),
    saveInstallMetadata: async (value: any) => { metadata = structuredClone(value); },
    listInstalledApps: async () => [],
  };
  // eslint-disable-next-line prefer-const
  let apps: Record<string, any>;
  const sources = sourceModule({ installed: () => apps.getAllInstalledApps() });
  // The box's clock starts an hour ago and moves a minute with every "check for updates" (which itself uses the wall
  // clock): each check is an explicit one, later than the last attempt.
  let clock = Date.now() - 3_600_000;
  const world = worldOf(sources, () => clock);
  const catalog = world.catalog;
  apps = load('src/lib/market/installed-apps.ts', {
    '@/lib/storage/json-store': {
      statePath: (name: string) => path.join(directory, 'state', name),
      writeJSON: async (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }),
    },
    'node:fs': nodeRequire('node:fs'), 'node:path': nodeRequire('node:path'),
    './update-executor-lock': nodeRequire(path.join(root, 'src/lib/market/update-executor-lock.ts')),
    './update-admission': { isAppUpdateReserved: () => false },
    './metadata': metadataModule,
    './catalog': { fetchCatalog: async () => ({ apps: [], bundles: [] }), resolveCatalogApp: catalog.resolveCatalogApp, isMarketAppUnavailable: catalog.isMarketAppUnavailable },
    './source': sources,
    './app-format/requires': nodeRequire(path.join(root, 'src/lib/market/app-format/requires.ts')),
    './update-routing': routing,
    '../releases/product-release': {},
    './platform-env': { getPlatformContext: async () => ({ version: '99.0.0' }) },
  });
  const updaterModule = load('src/lib/market/updater.ts', {
    './update-admission': { withAppLifecycle: (_appId: string, work: () => unknown) => work(), appUpdateJournalStore: () => ({}) },
    '../incus/app-network': { withAppNetworkOperationLock: (_appId: string, _operation: string, work: () => unknown) => work() },
    './installed-apps': apps,
    './metadata': metadataModule,
    './catalog': catalog,
    './update-routing': routing,
    './direct-apps': {},
    './frozen-manifest': {},
    './source': sources,
    '@/lib/version': version,
    // The first step after the source checks; reaching it means the update was allowed to go on.
    './platform-env': { assertYouEyeRequirement: async () => { throw new Error('past the source checks'); } },
  });
  const switchRoute = load('src/app/api/market/app/[appId]/source/route.ts', {
    'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources, '@/lib/market/catalog': catalog,
    '@/lib/market/direct-apps': {}, '@/lib/market/metadata': metadataModule, '@/lib/market/installed-apps': apps,
    ...switchLocks(),
  });
  const routes = sourceRoutes(sources, world);
  return {
    sources, world, routes,
    metadata: () => metadata,
    install: (state: Record<string, unknown> = {}) => apps.upsertInstalledApp({ appId: 'demo', type: 'market', installedVersion: '1.0.0', subdomain: 'demo',
      catalogKey: `${installedFrom.sourceId}:app:demo`, sourceId: installedFrom.sourceId, sourceName: installedFrom.sourceName, sourceRepoUrl: installedFrom.address, ...state }),
    stored: async () => (await apps.getInstalledApp('demo')) as Record<string, any>,
    check: async () => {
      clock += 60_000;
      world.catalog.clearCatalogCache();
      await apps.checkForUpdates();
      return (await apps.getInstalledApp('demo')) as Record<string, any>;
    },
    update: () => updaterModule.updateMarketApp({ appId: 'demo' }, () => {}),
    switchTo: (sourceId: string) => switchRoute.PATCH(new Request('https://cp.example.test/api', {
      method: 'PATCH', body: JSON.stringify({ sourceId }) }), { params: Promise.resolve({ appId: 'demo' }) }),
    editList: (active_sources: unknown[]) => routes.patch({ active_sources }),
    addSource: (body: Record<string, unknown>) => routes.route.POST(request({ acceptRisk: true, ...body })),
  };
}

function seedFriend(directory: string, address = TRUSTED, name = 'Friend') {
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true },
    { id: 'custom-1', name, url: address, enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
}

const sourceChanged = (error: any) => error.code === 'source-changed'
  && /installed from https:\/\/markets\.example\.org\/friend\/; the Market source "\w+" now points at https:\/\/markets\.example\.org\/foreign\//.test(error.message);

test('a removed source\'s id is not handed out again while an installed app records it', withDirectory(async (directory) => {
  seedFriend(directory);
  const scenario = addressScenario(directory);
  await scenario.install();
  assert.equal((await scenario.check()).updateAvailable, true, 'custom-1 (the friend\'s market) offers 2.0.0');
  // Remove the source the app came from, then add another market: it gets a new id.
  const list = await scenario.sources.getConfiguredMarketSources();
  assert.equal((await scenario.editList(list.filter((source: any) => source.id === 'official'))).status, 200);
  const added = await scenario.addSource({ url: FOREIGN });
  assert.equal(added.status, 200);
  assert.equal((await added.json()).source.id, 'custom-2', 'custom-1 is still recorded by demo');
  // A chosen id that the app records for another address is refused; for the same address it is allowed.
  const taken = await scenario.addSource({ url: LEGACY, id: 'custom-1' });
  assert.equal(taken.status, 400);
  assert.match((await taken.json()).error, /still records Market source "custom-1" for https:\/\/markets\.example\.org\/friend\//);
  assert.equal((await scenario.addSource({ url: `${TRUSTED}market.json`, id: 'custom-1' })).status, 200, 'the same market again');
  // Generation skips recorded ids and fills a gap otherwise; "direct" is reserved like "official".
  const now = '2026-11-18T12:00:00.000Z';
  const official = [scenario.sources.officialMarketSource()];
  assert.equal(scenario.sources.withAddedMarketSource(official, { url: FOREIGN }, now, [{ sourceId: 'custom-1' }, { sourceId: 'custom-2' }]).at(-1).id, 'custom-3');
  assert.equal(scenario.sources.withAddedMarketSource(official, { url: FOREIGN }, now).at(-1).id, 'custom-1');
  for (const id of ['direct', 'official']) {
    assert.throws(() => scenario.sources.withAddedMarketSource(official, { url: FOREIGN, id }, now), /not "official" or "direct"/);
  }
}));

test('an app does not take updates from another market under its source id until it is switched there',
  withDirectory(async (directory) => {
    // The id custom-1 names another market than the app was installed from (the id was handed out again, or the file edited).
    seedFriend(directory, FOREIGN, 'Stranger');
    const scenario = addressScenario(directory);
    await scenario.install();
    const blocked = await scenario.check();
    assert.equal(blocked.updateAvailable, false, 'the foreign market\'s 4.0.0 is not offered');
    assert.equal(blocked.catalogVersion, null);
    assert.equal(blocked.updateBlocked.code, 'source-changed');
    assert.ok(sourceChanged({ code: blocked.updateBlocked.code, message: blocked.updateBlocked.message }), blocked.updateBlocked.message);
    assert.equal(blocked.sourceRepoUrl, TRUSTED, 'the check does not re-record the address');
    await assert.rejects(scenario.update(), sourceChanged);
    assert.equal(scenario.metadata().installedVersion, '1.0.0');

    // The owner switches the app to the source on purpose (it is accepted): its updates come from there now.
    assert.equal((await scenario.switchTo('custom-1')).status, 200);
    assert.equal(scenario.metadata().sourceRepoUrl, FOREIGN);
    const offered = await scenario.check();
    assert.equal(offered.updateAvailable, true);
    assert.equal(offered.catalogVersion, '4.0.0');
    assert.equal(offered.updateBlocked, null);
    assert.equal((await scenario.update()).errorCode, 'requires-newer-youeye', 'past the source checks');
  }));

test('re-pointing a source and accepting it again does not move its installed apps',
  withDirectory(async (directory) => {
    seedFriend(directory);
    const scenario = addressScenario(directory);
    await scenario.install();
    const retarget = async (url: string) => {
      const list = await scenario.sources.getConfiguredMarketSources();
      assert.equal((await scenario.editList(list.map((source: any) => source.id === 'custom-1' ? { ...source, url } : source))).status, 200);
      await scenario.sources.acceptMarketSource('custom-1');
    };

    await retarget(FOREIGN);
    assert.equal((await scenario.check()).updateBlocked?.code, 'source-changed');
    await assert.rejects(scenario.update(), sourceChanged);

    // The original address: updates flow again without any switch.
    await retarget(TRUSTED);
    const offered = await scenario.check();
    assert.equal(offered.updateAvailable, true);
    assert.equal(offered.catalogVersion, '2.0.0');
    assert.equal(offered.updateBlocked, null);
  }));

// ─── Boxes that had git sources (before 0.6.11) ──────────────────────────────

const OLD_REPO = 'https://git.example.test/friend/market';

test('git sources are removed with a note; their apps keep running with "no update source" until switched; official apps go on',
  withDirectory(async (directory) => {
    // The source list of a 0.6.10 box: the official source and two git repositories.
    writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
      { id: 'official', enabled: true, trust: 'official', resolved_at: '2026-11-18T09:00:00.000Z' },
      { id: 'andrew-test', name: 'Andrew', repo_url: OLD_REPO, branch: 'dev', enabled: true, priority: 1, trust: 'custom', accepted_at: '2026-11-18T10:00:00.000Z' },
      { id: 'custom-1', name: 'Old', repo_url: 'https://github.com/someone/market', branch: 'main', enabled: false, priority: 2, trust: 'custom' },
    ] }));
    // "demo" was installed from the git source, and the last check before the update offered 2.0.0.
    const scenario = addressScenario(directory, { sourceId: 'andrew-test', sourceName: 'Andrew', address: OLD_REPO });
    await scenario.install();
    const stale = await scenario.stored();
    Object.assign(stale, { catalogVersion: '2.0.0', updateAvailable: true, candidateVersion: '2.0.0', updatePath: '1.0.0 -> 2.0.0' });
    writeFileSync(path.join(directory, 'state', 'installed-apps.json'), JSON.stringify({ apps: { demo: stale }, nextId: 2 }), { mode: 0o600 });
    assert.equal((await scenario.stored()).updateAvailable, true);

    // First read with this code: only the official Market is left; the file is rewritten once, with the note.
    const listed = await (await scenario.routes.route.GET()).json();
    assert.deepEqual(listed.sources.map((source: any) => [source.id, source.kind]), [['official', 'official']]);
    assert.deepEqual(listed.removed_sources.map((source: any) => [source.id, source.name, source.address, source.branch]),
      [['andrew-test', 'Andrew', OLD_REPO, 'dev'], ['custom-1', 'Old', 'https://github.com/someone/market', 'main']]);
    const file = JSON.parse(readFileSync(path.join(directory, 'market-sources.json'), 'utf8'));
    assert.deepEqual(file.active_sources, [{ id: 'official', enabled: true }]);
    assert.equal(file.removed_sources.length, 2);
    assert.deepEqual((await scenario.sources.getRemovedMarketSources()).map((source: any) => source.id), ['andrew-test', 'custom-1'], 'the note stays until it is dismissed');

    // The app keeps running; the check clears what was on offer and says there is no update source.
    const blocked = await scenario.check();
    assert.equal(blocked.updateAvailable, false);
    assert.equal(blocked.catalogVersion, null);
    assert.equal(blocked.candidateVersion, null);
    assert.equal(blocked.updatePath, null);
    assert.equal(blocked.updateBlocked.code, 'source-unavailable');
    assert.match(blocked.updateBlocked.message, /Market source "andrew-test" is not configured: this app has no update source/);
    assert.equal(blocked.sourceId, 'andrew-test', 'the check never moves an app to another source');
    assert.equal(blocked.sourceRepoUrl, OLD_REPO);
    await assert.rejects(scenario.update(), (error: any) => error.code === 'source-unavailable');
    assert.equal(scenario.metadata().installedVersion, '1.0.0');

    // Adding the market again (now by its address) gives it a new id: the app is not attached by itself.
    const taken = await scenario.addSource({ url: TRUSTED, id: 'andrew-test' });
    assert.equal(taken.status, 400);
    assert.match((await taken.json()).error, /still records Market source "andrew-test" for https:\/\/git\.example\.test\/friend\/market/);
    const added = await scenario.addSource({ url: TRUSTED });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).source.id, 'custom-1', 'a new id (no installed app records custom-1), never "andrew-test"');
    assert.equal((await scenario.check()).updateBlocked.code, 'source-unavailable');

    // The owner re-attaches the app with the switch: updates come from the market again.
    assert.equal((await scenario.switchTo('custom-1')).status, 200);
    assert.equal(scenario.metadata().sourceId, 'custom-1');
    assert.equal(scenario.metadata().sourceRepoUrl, TRUSTED);
    const offered = await scenario.check();
    assert.equal(offered.updateBlocked, null);
    assert.equal(offered.updateAvailable, true);
    assert.equal(offered.catalogVersion, '2.0.0');
    assert.equal((await scenario.update()).errorCode, 'requires-newer-youeye', 'past the source checks');

    // Dismissing the note.
    const dismissed = await (await scenario.routes.patch({ dismiss_removed_sources: true })).json();
    assert.deepEqual(dismissed.removed_sources, []);
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'market-sources.json'), 'utf8')).removed_sources, undefined);
  }));

test('an installed official app continues after the update without any step', withDirectory(async (directory) => {
  // As a 0.6.10 box recorded an app from the official catalog tar: source id "official", no address, repo "official".
  const scenario = addressScenario(directory, { sourceId: 'official', sourceName: 'Official YouEye Market', address: '' });
  Object.assign(scenario.metadata(), { manifestRepo: 'official', manifestBranch: '', sourceRepoUrl: undefined });
  await scenario.install({ sourceRepoUrl: undefined });
  const checked = await scenario.check();
  assert.equal(checked.updateBlocked, null);
  assert.equal(checked.catalogVersion, '1.0.0', 'the official market has the installed version');
  assert.equal(checked.updateAvailable, false);
  assert.equal(checked.sourceId, 'official');
  assert.ok(!checked.sourceRepoUrl, 'no address is recorded for the official Market');
  // A newer version in the official market is offered and the update gets past every source check.
  scenario.world.sites[OFFICIAL] = market('1.2.0', false);
  const offered = await scenario.check();
  assert.equal(offered.updateAvailable, true);
  assert.equal(offered.catalogVersion, '1.2.0');
  assert.equal((await scenario.update()).errorCode, 'requires-newer-youeye', 'past the source checks');
  // The channel changes (another lane, another address): still the official source, still no step.
  const beta = marketWorld({ [OFFICIAL_MARKET_ADDRESSES.dev]: market('1.3.0', false) }, { sources: scenario.sources, channel: 'dev' });
  assert.equal((await beta.store.refreshMarket(scenario.sources.officialMarketSource())).address, OFFICIAL_MARKET_ADDRESSES.dev);
  assert.equal(routing.recordedSourceAddressChange({ sourceRepoUrl: undefined }, scenario.sources.officialMarketSource()), null);
  assert.equal(routing.recordedSourceAddressChange({ sourceRepoUrl: OFFICIAL }, scenario.sources.officialMarketSource()), null);
}));

test('an update that needs a newer YouEye is not offered and says why', withDirectory(async (directory) => {
  seedFriend(directory);
  const scenario = addressScenario(directory);
  await scenario.install({ catalogVersion: '1.5.0', updateAvailable: true });
  scenario.world.sites[TRUSTED] = buildFixtureMarket({ sequence: 1795000900, apps: [{ id: 'demo', version: '9.0.0', entry: { requires: { youeye: '>=100.0.0' } }, bundle: { layout: 2 } }] }).files;
  const checked = await scenario.check();
  assert.equal(checked.updateAvailable, false);
  assert.equal(checked.catalogVersion, '9.0.0');
  assert.equal(checked.updateBlocked.code, 'requires-newer-youeye');
  assert.match(checked.updateBlocked.message, /needs YouEye ≥ 100\.0\.0/);
  const result = await scenario.update();
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'requires-newer-youeye');
  assert.equal(result.newVersion, '9.0.0');
}));

test('the update API answers source-changed with 403 and the refusal\'s own message', async () => {
  const refusal = Object.assign(new Error('This app was installed from A; the Market source "x" now points at B.'),
    { name: 'MarketSourceConsentError', code: 'source-changed' });
  const http = load('src/lib/market/update-http.ts', {
    'next/server': next,
    '@/lib/auth/rbac': admin,
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/market/installed-apps': { getInstalledApp: async () => ({ appId: 'demo' }) },
    '@/lib/market/updater': { updateMarketApp: async () => { throw refusal; } },
    '@/lib/market/update-operations': { getAppUpdateOperation: () => null },
    '@/lib/market/update-admission': { withUserOperationLockWait: (work: () => unknown) => work() },
    '@/lib/market/install-tracker': { logOperationFailure() {} },
    '@/lib/http/lifecycle-busy': { isLifecycleBusy: () => false },
  });
  const answer = await http.handleMarketUpdate(request({}), 'demo', 'json');
  assert.equal(answer.status, 403);
  const body = await answer.json();
  assert.equal(body.code, 'source-changed');
  assert.equal(body.message, refusal.message);
  assert.match(await (await http.handleMarketUpdate(request({ appId: 'demo' }))).text(), /"stage":"failed".*now points at B.*"code":"source-changed"/);
});

test('the refresh call asks the markets now and says what each answered', withDirectory(async (directory) => {
  seedSources(directory);
  const sources = sourceModule();
  const { refresh, world } = sourceRoutes(sources);
  world.sites[LEGACY] = new Map();   // the stranger's market is gone
  const all = await (await refresh.POST(request({}))).json();
  assert.deepEqual(all.results.map((result: any) => [result.id, result.ok]), [['official', true], ['legacy', false], ['trusted', true]]);
  assert.match(all.results[1].error, /market\.json: HTTP 404/);
  assert.equal(all.results[2].commit, 'demo-2.0.0');
  const views = Object.fromEntries(all.sources.map((source: any) => [source.id, source]));
  assert.equal(views.official.address, OFFICIAL);
  assert.equal(views.official.market.apps, 1);
  assert.match(views.official.refreshed_at, /^\d{4}-/);
  assert.equal(views.legacy.market, null);
  assert.match(views.legacy.refresh_error, /HTTP 404/);
  assert.equal(views.trusted.market.name, 'Test Market');
  // One source by id: one conditional request when nothing changed.
  world.hosts.take();
  const one = await (await refresh.POST(request({ id: 'trusted' }))).json();
  assert.deepEqual(one.results, [{ id: 'trusted', ok: true, sequence: 1795000000, commit: 'demo-2.0.0' }]);
  assert.deepEqual(world.hosts.requests.map((item) => [item.path, item.status]), [['market.json', 304]]);
  assert.equal((await refresh.POST(request({ id: 'nope' }))).status, 404);
}));

// ─── The source list file: one writer, no needless writes ────────────────────

test('two copies of the source module share one write chain; reading and refreshing a market never write the list',
  withDirectory(async (directory) => {
    seedSources(directory);
    const writes: string[] = [];
    const routes = sourceModule({ writes });
    const background = sourceModule({ writes });
    // Adds, accepts and list edits from both copies at once: none of them reverts another.
    await Promise.all([
      ...Array.from({ length: 6 }, (_, n) => routes.addMarketSource({ url: `https://markets.example.org/owner${n}/` })),
      ...Array.from({ length: 6 }, (_, n) => background.addMarketSource({ url: `https://markets.example.org/other${n}/` })),
      background.acceptMarketSource('legacy'),
    ]);
    const list = await routes.getConfiguredMarketSources();
    assert.equal(list.filter((source: any) => /owner\d|other\d/.test(source.url)).length, 12, 'every add survives');
    assert.equal(new Set(list.map((source: any) => source.id)).size, list.length, 'every source has its own id');
    assert.ok(list.find((source: any) => source.id === 'legacy').accepted_at);
    assert.equal(new Set(writes).size, writes.length, 'every write has its own temporary file');
    assert.equal(writes.length, 13);

    // What a market holds and when it was refreshed live in its store: the list file is not written for them.
    writes.length = 0;
    const world = worldOf(routes);
    await world.catalog.fetchAvailableApps();
    world.catalog.clearCatalogCache();
    await world.catalog.fetchAvailableApps().catch(() => undefined);
    await background.getConfiguredMarketSources();
    await background.getRemovedMarketSources();
    assert.deepEqual(writes, []);
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'market-sources.json'), 'utf8')).active_sources.some((entry: any) => 'refresh_error' in entry || 'resolved_at' in entry), false);
  }));

// ─── D3: the update check never re-points an app ─────────────────────────────

test('the update check asks only the recorded source (else the official one) and never moves an app', withDirectory(async (directory) => {
  const previous = process.env.YOUEYE_INSTALLED_APPS_PATH;
  process.env.YOUEYE_INSTALLED_APPS_PATH = path.join(directory, 'state', 'installed-apps.json');
  mkdirSync(path.join(directory, 'state'), { recursive: true, mode: 0o700 });
  try {
    const resolved: Array<[string, string | undefined]> = [];
    const directFetches: string[] = [];
    const metadata: Record<string, Record<string, unknown>> = {
      plain: { appId: 'plain', itemKind: 'app', manifestPath: 'apps/plain/youeye-app.yaml' },
      custom: { appId: 'custom', sourceId: 'trusted' },
      added: { appId: 'added', sourceId: 'direct:abc' },
    };
    const apps = load('src/lib/market/installed-apps.ts', {
      '@/lib/storage/json-store': {
        statePath: (name: string) => path.join(directory, 'state', name),
        writeJSON: async (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }),
      },
      'node:fs': nodeRequire('node:fs'), 'node:path': nodeRequire('node:path'),
      './update-executor-lock': nodeRequire(path.join(root, 'src/lib/market/update-executor-lock.ts')),
      './update-admission': { isAppUpdateReserved: () => false },
      './metadata': { readInstallMetadata: async (appId: string) => metadata[appId] ?? null, listInstalledApps: async () => [] },
      './catalog': {
        fetchCatalog: async () => ({ apps: [{ id: 'plain', integration: 'basic', path: 'apps/plain' }], bundles: [] }),
        isMarketAppUnavailable: () => false,
        resolveCatalogApp: async (appId: string, sourceId?: string) => {
          resolved.push([appId, sourceId]);
          const id = sourceId ?? 'official';
          return { source: id === 'official' ? realSources.officialMarketSource() : realSources.customMarketSource(TRUSTED, { id, name: id }),
            entry: { id: appId, integration: 'basic', path: `apps/${appId}` },
            manifest: { version: '9.0.0', integration: 'basic' }, reference: { path: '', repo: '', branch: '', digest: '' } };
        },
      },
      './source': realSources,
      './app-format/requires': nodeRequire(path.join(root, 'src/lib/market/app-format/requires.ts')),
      './update-routing': routing,
      '../releases/product-release': {},
      './platform-env': { getPlatformContext: async () => ({ version: '0.6.10' }) },
      './direct-apps': { fetchDirectMarketAppUpdate: async (sourceId: string) => { directFetches.push(sourceId); return { manifest: { version: '2.0.0' } }; } },
    });
    for (const [appId, sourceId] of [['plain', null], ['custom', 'trusted'], ['added', 'direct:abc']] as const) {
      await apps.upsertInstalledApp({ appId, type: 'market', installedVersion: '1.0.0', subdomain: appId, sourceId });
    }
    await apps.checkForUpdates();
    assert.deepEqual(resolved.sort(), [['custom', 'trusted'], ['plain', undefined]]);
    assert.deepEqual(directFetches, ['direct:abc']);
    const store = JSON.parse(readFileSync(process.env.YOUEYE_INSTALLED_APPS_PATH!, 'utf8')).apps;
    assert.equal(store.plain.sourceId, 'official', 'an app without a source gets the official one, nothing else');
    assert.ok(!store.plain.sourceRepoUrl, 'and no address: the official Market has none to record');
    assert.equal(store.custom.sourceId, 'trusted');
    assert.equal(store.custom.sourceRepoUrl, TRUSTED, 'a custom market\'s address is recorded once');
    assert.equal(store.added.sourceId, 'direct:abc');
    assert.equal(store.added.updateAvailable, true, 'URL apps are checked again');
  } finally {
    if (previous === undefined) delete process.env.YOUEYE_INSTALLED_APPS_PATH;
    else process.env.YOUEYE_INSTALLED_APPS_PATH = previous;
  }
}));

// ─── D7: a URL app's update with changed setup files asks again ──────────────

function updater(installed: ReturnType<typeof appFixture>, refreshed: ReturnType<typeof appFixture>, sources: Record<string, any>) {
  const saved: unknown[] = [];
  const module = load('src/lib/market/updater.ts', {
    './update-admission': { withAppLifecycle: (_appId: string, work: () => unknown) => work(), appUpdateJournalStore: () => ({}) },
    '../incus/app-network': { withAppNetworkOperationLock: (_appId: string, _operation: string, work: () => unknown) => work() },
    './installed-apps': { getInstalledApp: async () => ({ appId: 'demo', installedVersion: '1.0.0', sourceId: 'direct:abc' }) },
    './metadata': { readInstallMetadata: async () => ({ appId: 'demo', sourceId: 'direct:abc', serviceCredentialState: 'ready', containers: [] }) },
    './catalog': { clearCatalogCache() {}, isMarketAppUnavailable: () => false },
    './update-routing': routing,
    './direct-apps': {
      fetchDirectMarketAppUpdate: async () => ({
        entry: { sourceId: 'direct:abc', manifestUrl: 'https://apps.example.test/demo.yaml', manifest: installed }, manifest: refreshed,
      }),
      saveDirectMarketApp: async (value: unknown) => { saved.push(value); },
    },
    './frozen-manifest': { readFrozenUpdateManifest: async () => installed },
    './source': sources,
    '@/lib/version': version,
    // The first step after the consent check; reaching it means the update was allowed to go on.
    './platform-env': { assertYouEyeRequirement: async () => { throw new Error('past the consent check'); } },
  });
  return { saved, update: (config: Record<string, unknown>) => module.updateMarketApp({ appId: 'demo', ...config }, () => {}) };
}

test('an update of an app added by URL whose setup files changed needs allowSetup and saves nothing before it',
  withDirectory(async () => {
    const sources = sourceModule();
    const installed = appFixture({ version: '1.0.0' }, { 'setup/install.yaml': SETUP_A });
    const changed = appFixture({ version: '1.1.0' }, { 'setup/install.yaml': SETUP_B });
    const { saved, update } = updater(installed, changed, sources);
    const refused = await update({});
    assert.equal(refused.success, false);
    assert.equal(refused.errorCode, 'setup-changed');
    assert.deepEqual(refused.setups, [{ name: 'setup/install.yaml', for: 'install' }]);
    assert.deepEqual(saved, [], 'the refreshed manifest is not saved over the one the owner agreed to');
    assert.equal((await update({ allowSetup: true })).errorCode, 'requires-newer-youeye');

    const same = updater(installed, appFixture({ version: '1.1.0' }, { 'setup/install.yaml': SETUP_A }), sources);
    assert.equal((await same.update({})).errorCode, 'requires-newer-youeye', 'unchanged setup files need no new consent');
    assert.equal(sources.setupFilesChanged(installed, appFixture({ version: '1.1.0' })), true, 'removing a setup file is a change');
  }));

test('the update API passes allowSetup and answers setup-changed with the setup files', async () => {
  const configs: any[] = [];
  const http = load('src/lib/market/update-http.ts', {
    'next/server': next,
    '@/lib/auth/rbac': admin,
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/market/installed-apps': { getInstalledApp: async () => ({ appId: 'demo' }) },
    '@/lib/market/updater': { updateMarketApp: async (config: unknown) => {
      configs.push(config);
      return { success: false, previousVersion: '1.0.0', newVersion: '1.1.0', migrationsRun: 0, errorCode: 'setup-changed',
        setups: [{ name: 'setup/install.yaml', for: 'install' }] };
    } },
    '@/lib/market/update-operations': { getAppUpdateOperation: () => null },
    '@/lib/market/update-admission': { withUserOperationLockWait: (work: () => unknown) => work() },
    '@/lib/market/install-tracker': { logOperationFailure() {} },
    '@/lib/http/lifecycle-busy': { isLifecycleBusy: () => false },
  });
  const jsonAnswer = await http.handleMarketUpdate(request({ allowSetup: true }), 'demo', 'json');
  assert.equal(jsonAnswer.status, 409);
  const body = await jsonAnswer.json();
  assert.equal(body.code, 'setup-changed');
  assert.match(body.error, /Setup steps changed/);
  assert.deepEqual(body.setups, [{ name: 'setup/install.yaml', for: 'install' }]);
  assert.deepEqual(configs[0], { appId: 'demo', allowSetup: true });

  const stream = await (await http.handleMarketUpdate(request({ appId: 'demo' }))).text();
  assert.match(stream, /"stage":"failed".*"code":"setup-changed"/);
  assert.deepEqual(configs[1], { appId: 'demo', allowSetup: false });
  assert.equal((await http.handleMarketUpdate(request({ appId: 'demo', allowSetup: 'yes' }))).status, 400);
});
