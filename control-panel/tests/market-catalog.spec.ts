/**
 * The Market reader (src/lib/market/catalog.ts) on the box's store: what is listed, what an install records, what
 * is refused, and that listing never waits for the network.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadApp } from '../src/lib/market/app-format/compile';
import { resolveAppIcon } from '../src/lib/market/app-icon';
import { parseFrozenAppManifest } from '../src/lib/market/frozen-manifest';
import { MARKET_POINTER_FILE, sha256Hex } from '../src/lib/market/market-format';
import { OFFICIAL_MARKET_ADDRESSES } from '../src/lib/market/source';
import { appYAML, nativeFixture } from './fixtures/app-format';
import { buildFixtureMarket } from './fixtures/market';
import { marketWorld, root, withMarketState } from './fixtures/market-world';
import { freeLifecycle } from './fixtures/free-lifecycle';

const OFFICIAL = OFFICIAL_MARKET_ADDRESSES.main;
const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
const SHOT = Buffer.from('screenshot bytes');
const SETUP = 'schema: youeye.setup.v1\nfor: install\nsteps:\n  - wait: { http: /health }\n';

test('an app is listed from its bundle, with pictures on this box and the record an install keeps', withMarketState(async () => {
  const built = buildFixtureMarket({
    sequence: 1795000000, commit: '60f999c4',
    apps: [{ id: 'trek', version: '5.1.4', setups: { 'install.yaml': SETUP }, pictures: { 'icon.svg': ICON, 'screenshots/a.webp': SHOT } }, { id: 'plain' }],
    native: ['notes'], bundles: [{ id: 'pair', members: ['trek', 'plain'] }],
  });
  const world = marketWorld({ [OFFICIAL]: built.files }, { native: { notes: nativeFixture({ id: 'notes', name: 'Notes', version: '0.6.3' }) } });
  const warnings: unknown[] = [];
  const apps = await world.catalog.fetchAvailableApps((warning: unknown) => warnings.push(warning));
  assert.deepEqual(warnings, []);
  assert.deepEqual(apps.map((app: any) => [app.id, app.integration, app.version]), [['notes', 'native', '0.6.3'], ['plain', 'basic', '1.0.0'], ['trek', 'basic', '5.1.4']]);

  const trek = apps.find((app: any) => app.id === 'trek');
  assert.equal(trek.catalogKey, 'official:app:trek');
  assert.equal(trek.sourceId, 'official');
  assert.equal(trek.sourceRepoUrl, undefined, 'the official Market records no address: it follows the box\'s channel');
  assert.equal(trek.manifestPath, 'apps/trek/youeye-app.yaml');
  assert.equal(trek.manifestRepo, OFFICIAL, 'the market address the bundle was read from');
  assert.equal(trek.manifestBranch, '60f999c4', 'the market\'s commit');
  assert.match(trek.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(trek.setups, [{ name: 'setup/install.yaml', for: 'install' }]);
  assert.equal(trek.installBlocked, undefined);
  // Pictures are this box's image route, by the hashed path of the market.
  const icon = built.picturePaths.trek['icon.svg'];
  assert.equal(trek.iconUrl, `/api/market/image?source=official&file=${encodeURIComponent(icon)}`);
  assert.deepEqual(trek.detail.screenshots, [{ url: `/api/market/image?source=official&file=${encodeURIComponent(built.picturePaths.trek['screenshots/a.webp'])}`, caption: undefined }]);
  assert.equal(apps.find((app: any) => app.id === 'plain').iconUrl, undefined);

  // What an install or update resolves is the same manifest and reference.
  const resolved = await world.catalog.resolveCatalogApp('trek');
  assert.equal(resolved.source.id, 'official');
  assert.deepEqual(resolved.entry, { id: 'trek', integration: 'basic', path: 'apps/trek' });
  assert.deepEqual(resolved.reference, { path: 'apps/trek/youeye-app.yaml', repo: OFFICIAL, branch: '60f999c4', digest: trek.manifestDigest });
  assert.equal(resolved.manifest.frozen.manifest, built.manifests.trek, 'the frozen copy is the market\'s manifest text');
  assert.deepEqual(resolved.manifest.frozen.setups, { 'setup/install.yaml': SETUP });
  const native = await world.catalog.resolveCatalogApp('notes');
  assert.deepEqual(native.entry, { id: 'notes', integration: 'native' });
  assert.deepEqual(native.reference, { path: 'youeye-app.yaml', repo: 'https://git.example.test/owner/notes', branch: 'v0.6.3', digest: native.manifest.frozen.digest, key: { line: '0.6.3', sequence: 1762950000 }, artifactSHA256: 'a'.repeat(64) });
  await assert.rejects(world.catalog.resolveCatalogApp('absent'), /App "absent" could not be resolved from Market source "official" \(app is not present\)/);

  // Callers may change what they get; the next reader is not affected.
  resolved.manifest.metadata.name = 'changed';
  assert.equal((await world.catalog.fetchManifest('trek')).metadata.name, 'trek');
  assert.equal((await world.catalog.fetchManifestFromSource('trek', 'official')).version, '5.1.4');
  await assert.rejects(world.catalog.fetchManifest('absent'), /not found in catalog/);

  // The catalog, categories and bundles come from the index.
  assert.deepEqual(await world.catalog.fetchCatalog(), {
    apps: [{ id: 'notes', integration: 'native' }, { id: 'plain', integration: 'basic', path: 'apps/plain' }, { id: 'trek', integration: 'basic', path: 'apps/trek' }],
    bundles: ['pair'], categories: [{ id: 'utilities', label: 'Utilities', order: 1 }], curation: undefined,
  });
  assert.deepEqual((await world.catalog.fetchCategories()).map((category: any) => category.id), ['utilities']);
  assert.equal(await world.catalog.fetchCuration(), null);
  assert.deepEqual((await world.catalog.fetchBundles()).map((bundle: any) => [bundle.id, bundle.sourceId, bundle.members]), [['pair', 'official', ['trek', 'plain']]]);
  assert.equal((await world.catalog.fetchBundle('pair')).sourceId, 'official');
  assert.equal(await world.catalog.fetchBundle('pair', 'custom-1'), null);

  // The dashboard icon is inlined from the box's copy of the market, for the source the app installs from only.
  const read = world.store.readInstallIconPicture;
  assert.equal(await resolveAppIcon({ appId: 'trek', iconUrl: trek.iconUrl, lucide: 'box', sourceId: 'official' }, read),
    `data:image/svg+xml;base64,${ICON.toString('base64')}`);
  for (const [iconUrl, sourceId] of [
    [trek.iconUrl, 'custom-1'], [trek.iconUrl, 'direct:abc'], [trek.iconUrl, undefined],
    [`/api/market/image?source=official&file=${encodeURIComponent(`h/files/${sha256Hex('unnamed')}.svg`)}`, 'official'],
    ['/api/market/image?url=https%3A%2F%2Fevil.example.org%2Fx.svg', 'official'], ['https://evil.example.org/x.svg', 'official'],
    ['/api/market/image?source=official&file=..%2Fstate.json', 'official'],
  ] as const) {
    const before = world.hosts.requests.length;
    assert.equal(await resolveAppIcon({ appId: 'trek', iconUrl, lucide: 'box', sourceId }, read), 'box', `${iconUrl} ${sourceId}`);
    assert.equal(world.hosts.requests.length, before, 'no request for a picture the market does not name');
  }
}));

test('listing reads the store: page views cost no request; an explicit check costs one', withMarketState(async () => {
  const built = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'alpha' }, { id: 'beta' }], native: ['notes'] });
  // An hour ago, so that the explicit check at the end (which uses the wall clock) is later than every attempt here.
  let now = Date.now() - 3_600_000;
  const world = marketWorld({ [OFFICIAL]: built.files }, { native: { notes: nativeFixture({ id: 'notes', name: 'Notes' }) }, now: () => now });
  await world.catalog.fetchAvailableApps();
  assert.deepEqual(world.hosts.take(), [MARKET_POINTER_FILE, built.indexPath, built.bundlePaths.alpha, built.bundlePaths.beta]);
  for (let view = 0; view < 20; view += 1) {
    now += 10_000;
    await Promise.all([
      world.catalog.fetchAvailableApps(), world.catalog.fetchCatalog(), world.catalog.fetchCategories(), world.catalog.fetchCuration(),
      world.catalog.fetchBundles(), world.catalog.fetchManifest('alpha'), world.catalog.resolveCatalogApp('beta'),
    ]);
  }
  assert.equal(world.hosts.requests.length, 0, '200 seconds of page views: the market is not asked');
  // An explicit check asks once (one conditional request), whatever number of readers follow.
  world.catalog.clearCatalogCache();
  now = Date.now();
  await Promise.all([world.catalog.fetchAvailableApps(), world.catalog.fetchCatalog(), world.catalog.fetchManifest('alpha')]);
  await world.catalog.fetchAvailableApps();
  assert.deepEqual(world.hosts.requests.map((request) => [request.path, request.status]), [[MARKET_POINTER_FILE, 304]]);
  assert.deepEqual(world.nativeRequests.length > 0 && new Set(world.nativeRequests).size, 1);
}));

test('an app that needs a newer YouEye, or is of an unknown kind, is listed and refused; its bundle is not parsed', withMarketState(async () => {
  const built = buildFixtureMarket({
    sequence: 1795000000,
    apps: [
      { id: 'fine', entry: { requires: { youeye: '>=0.6.9' } }, changes: { requires: { youeye: '>=0.6.9' } } },
      // Needs 0.6.12; its bundle uses something this reader has never seen.
      { id: 'future', version: '2.0.0', entry: { requires: { youeye: '>=0.6.12' }, tagline: 'From the future' }, bundle: { layout: 2, parts: ['x'] }, pictures: { 'icon.svg': ICON } },
      // A kind this YouEye does not know, with and without a stated requirement.
      { id: 'vm-app', entry: { kind: 'virtual-machine', requires: { youeye: '>=0.7.0' } }, bundle: { machine: {} } },
      { id: 'odd', entry: { kind: 'wasm', bundle: undefined } },
    ],
  });
  const world = marketWorld({ [OFFICIAL]: built.files }, { boxVersion: '0.6.11-dev.3' });
  const warnings: any[] = [];
  const apps = await world.catalog.fetchAvailableApps((warning: unknown) => warnings.push(warning));
  assert.deepEqual(warnings, [], 'a too-new app is not a warning: it is listed');
  assert.deepEqual(apps.map((app: any) => [app.id, app.installBlocked?.code ?? null, app.needsYouEye ?? null]), [
    ['fine', null, null], ['future', 'requires-newer-youeye', '0.6.12'], ['odd', 'requires-newer-youeye', null], ['vm-app', 'requires-newer-youeye', '0.7.0'],
  ]);
  const future = apps.find((app: any) => app.id === 'future');
  assert.equal(future.version, '2.0.0');
  assert.equal(future.description, 'future app');
  assert.equal(future.tagline, 'From the future');
  assert.equal(future.requiresYouEye, '>=0.6.12');
  assert.match(future.installBlocked.message, /needs YouEye ≥ 0\.6\.12; this box runs 0\.6\.11-dev\.3/);
  assert.equal(future.iconUrl, `/api/market/image?source=official&file=${encodeURIComponent(built.picturePaths.future['icon.svg'])}`);
  assert.equal(future.manifestDigest, undefined);
  assert.match(apps.find((app: any) => app.id === 'odd').installBlocked.message, /needs a newer YouEye than this box runs/);

  // Install and update resolve through the same refusal, with the reason and the version needed.
  for (const [id, needs] of [['future', '0.6.12'], ['vm-app', '0.7.0'], ['odd', undefined]] as const) {
    await assert.rejects(world.catalog.resolveCatalogApp(id), (error: any) =>
      error.name === 'MarketAppUnavailableError' && error.code === 'requires-newer-youeye' && error.needsYouEye === needs, id);
    await assert.rejects(world.catalog.fetchManifest(id), (error: any) => error.code === 'requires-newer-youeye');
  }
  assert.equal((await world.catalog.resolveCatalogApp('fine')).manifest.version, '1.0.0');

  // The same market on a box that is new enough: `future` now fails its strict parse and says why (below).
  const newer = marketWorld({ [OFFICIAL]: built.files }, { boxVersion: '0.6.12' });
  const later: any[] = [];
  const listed = await newer.catalog.fetchAvailableApps((warning: unknown) => later.push(warning));
  assert.deepEqual(listed.map((app: any) => [app.id, app.installBlocked?.code ?? null]), [['fine', null], ['odd', 'requires-newer-youeye'], ['vm-app', 'requires-newer-youeye']]);
  assert.equal(later.length, 1);
  assert.equal(later[0].itemId, 'future');
  assert.match(later[0].message, /future could not be loaded: the app bundle: manifest:/);
  // When Spine cannot say the box's version, nothing is held back here (the install checks it again).
  const unknown = marketWorld({ [OFFICIAL]: built.files }, { boxVersion: '0.0.0' });
  assert.equal((await unknown.catalog.resolveCatalogApp('fine')).manifest.version, '1.0.0');
}));

test('the install route refuses an app that needs a newer YouEye, with the reason and the version', withMarketState(async () => {
  const built = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'future', entry: { requires: { youeye: '>=0.6.12' } }, bundle: { layout: 2 } }, { id: 'fine' }] });
  const world = marketWorld({ [OFFICIAL]: built.files });
  const installs: any[] = [];
  const session = async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } });
  const admin = { requireAdmin: session, requireAdminCsrf: session };
  const route = (await import('./fixtures/market-world')).load('src/app/api/market/install/route.ts', {
    'next/server': {}, '@/lib/market/catalog': world.catalog, '@/lib/market/source': world.sources,
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
    '@/lib/auth/rbac': admin, '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/admission/management': { admissionAdministrator: async () => '20000000-0000-4000-8000-000000000001' },
    '@/lib/identity/store': {}, '@/lib/market/install-ai-settings': {},
    '@/lib/market/direct-apps': { getDirectMarketApp: async () => null },
    '@/lib/market/installed-apps': { updateInstalledAppSource: async () => {} },
  });
  const post = async (body: unknown) => {
    const response = await route.POST(new Request('https://cp.example.test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    if (response.headers.get('content-type')?.includes('event-stream')) await response.text();
    return response;
  };
  const refusedInstall = await post({ appId: 'future' });
  assert.equal(refusedInstall.status, 409);
  const body = await refusedInstall.json();
  assert.equal(body.code, 'requires-newer-youeye');
  assert.equal(body.needsYouEye, '0.6.12');
  assert.match(body.error, /needs YouEye ≥ 0\.6\.12/);
  assert.equal(installs.length, 0);
  assert.equal((await post({ appId: 'fine' })).status, 200);
  assert.equal(installs[0].manifestPath, 'apps/fine/youeye-app.yaml');
  assert.equal(installs[0].manifestRepo, OFFICIAL);
  assert.equal(installs[0].sourceRepoUrl, undefined);
}));

test('a malformed index entry is skipped with a warning; a manifest that does not parse says why; the others are listed', withMarketState(async () => {
  const badManifest = appYAML({ id: 'broken', name: 'Broken', frobnicate: true });
  const built = buildFixtureMarket({
    sequence: 1795000000,
    apps: [
      { id: 'good' },
      { id: 'broken', manifest: badManifest },
      { id: 'wrongid', manifest: appYAML({ id: 'other', name: 'Other' }) },
      { id: 'unpinned', manifest: appYAML({ id: 'unpinned', name: 'Unpinned', image: 'ghcr.io/example/demo:latest' }) },
      { id: 'stray', setups: { 'install.yaml': SETUP, 'extra.yaml': 'schema: youeye.setup.v1\nfor: sso\nsteps: []\n' } },
    ],
    rawApps: [
      { id: 'Not An Id', kind: 'container', name: 'x' }, 'not even an object', { id: 'good', kind: 'container', name: 'Good twice' },
      { id: 'elsewhere', kind: 'container', name: 'Elsewhere', bundle: { path: `h/apps/other/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), size: 10 } },
    ],
  });
  const world = marketWorld({ [OFFICIAL]: built.files });
  const warnings: any[] = [];
  const apps = await world.catalog.fetchAvailableApps((warning: unknown) => warnings.push(warning));
  assert.deepEqual(apps.map((app: any) => app.id), ['good'], 'one bad app never hides the others');
  const text = warnings.map((warning) => warning.message).join('\n');
  // Skipped index entries, in the index's own words.
  assert.match(text, /Official YouEye Market: skipped app Not An Id: id:/);
  assert.match(text, /skipped app #6: /);
  assert.match(text, /skipped app good: listed twice/);
  assert.match(text, /skipped app elsewhere: bundle\.path: bundle path is for another app/);
  // The real parser error, not "could not load".
  assert.match(text, /broken could not be loaded: youeye-app\.yaml: .*frobnicate/);
  assert.match(text, /wrongid could not be loaded: its bundle holds app "other"/);
  assert.match(text, /unpinned could not be loaded: youeye-app\.yaml: image: image must be pinned by digest/);
  assert.match(text, /stray could not be loaded: .*setup\/extra\.yaml/);
  assert.deepEqual(warnings.filter((warning) => warning.itemId).map((warning) => warning.itemId).sort(), ['broken', 'stray', 'unpinned', 'wrongid']);
  // Install says the same.
  await assert.rejects(world.catalog.resolveCatalogApp('broken'), /could not be resolved from Market source "official" \(app manifest could not be loaded: youeye-app\.yaml: .*frobnicate/);
}));

test('a source that cannot be read is reported with the reason and does not hide the others', withMarketState(async (directory) => {
  const built = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'good' }] });
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true },
    { id: 'custom-1', name: 'Gone', url: 'https://markets.example.org/gone/', enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
  const world = marketWorld({ [OFFICIAL]: built.files });
  const warnings: any[] = [];
  const apps = await world.catalog.fetchAvailableApps((warning: unknown) => warnings.push(warning));
  assert.deepEqual(apps.map((app: any) => app.id), ['good']);
  assert.deepEqual(warnings, [{ sourceId: 'custom-1', message: 'Gone: could not load its catalog: market.json: HTTP 404' }]);
  await assert.rejects(world.catalog.resolveCatalogApp('good', 'custom-1'), /catalog could not be loaded: market\.json: HTTP 404/);
  assert.deepEqual((await world.catalog.fetchCategories()).map((category: any) => category.id), ['utilities']);
}));

// ─── From the catalog tar to the store ────────────────────

test('an app installed from the old catalog tar updates from the store without a digest mismatch', withMarketState(async () => {
  // What the tar carried for the app: its manifest text and every file under setup/, by `setup/<name>`.
  const manifestText = appYAML({ id: 'demo', version: '1.0.0', listing: { description: 'Demo app', category: 'utilities', icon: 'box', icon_file: 'icon.svg' } });
  const fromTar = loadApp({ manifest: manifestText, setups: { 'setup/install.yaml': SETUP } });
  // The install record and the registration's frozen copy of that install.
  const record = { manifestDigest: fromTar.frozen!.digest, installedVersion: '1.0.0' };
  const registration = JSON.stringify({ frozen: fromTar.frozen });

  // The same commit of the catalog, published as a market: identical text, identical digest.
  const same = buildFixtureMarket({ sequence: 1795000000, commit: 'c1', apps: [{ id: 'demo', manifest: manifestText, setups: { 'install.yaml': SETUP }, pictures: { 'icon.svg': ICON } }] });
  const sites = { [OFFICIAL]: same.files };
  let now = Date.now() - 3_600_000;
  const world = marketWorld(sites, { now: () => now });
  const unchanged = await world.catalog.resolveCatalogApp('demo');
  assert.equal(unchanged.reference.digest, record.manifestDigest, 'the store yields the digest the tar install recorded');
  assert.deepEqual(unchanged.manifest.frozen, fromTar.frozen);
  assert.equal(unchanged.reference.path, 'apps/demo/youeye-app.yaml');

  // The updater's check of the installed copy against its record does not involve the market at all…
  assert.equal(parseFrozenAppManifest(registration, 'demo', record.installedVersion, record.manifestDigest).frozen!.digest, record.manifestDigest);
  // …and a new version in the store is an ordinary update of it.
  sites[OFFICIAL] = buildFixtureMarket({ sequence: 1795000100, commit: 'c2',
    apps: [{ id: 'demo', manifest: manifestText.replace('version: 1.0.0', 'version: 1.1.0'), setups: { 'install.yaml': SETUP } }] }).files;
  world.catalog.clearCatalogCache();   // "check for updates"
  now = Date.now();
  const next = await world.catalog.resolveCatalogApp('demo');
  assert.equal(next.manifest.version, '1.1.0');
  assert.notEqual(next.reference.digest, record.manifestDigest, 'a new version has its own digest, recorded when the update commits');
  assert.equal(parseFrozenAppManifest(registration, 'demo', record.installedVersion, record.manifestDigest).version, '1.0.0', 'still no mismatch before the update');
  // A changed listing text (icon, description) is not a new digest: store text never touches it.
  const relisted = loadApp({ manifest: manifestText.replace('Demo app', 'A demo app'), setups: { 'setup/install.yaml': SETUP } });
  assert.equal(relisted.frozen!.digest, record.manifestDigest);
}));

test('every app of the real catalog has the same digest from the generated market as from its repository files', async (t) => {
  const repoRoot = path.join(root, '..', '..');
  const marketRoot = [process.env.MARKET_ROOT && path.resolve(root, process.env.MARKET_ROOT), path.join(repoRoot, 'YE-AppMarket')]
    .find((candidate): candidate is string => !!candidate && existsSync(path.join(candidate, 'catalog.yaml')));
  if (!marketRoot) { t.skip('YE-AppMarket is not checked out beside YouEye (set MARKET_ROOT)'); return; }
  const generator = await import('../scripts/market-build').catch(() => null) as typeof import('../scripts/market-build') | null;
  if (!generator?.buildMarket) { t.skip('the market generator is not available'); return; }
  let market: ReturnType<typeof generator.buildMarket>;
  try { market = generator.buildMarket(marketRoot, { commit: 'fixture', sequence: 1795000000 }); }
  catch (error) { t.skip(`the catalog does not build right now: ${error instanceof Error ? error.message.split('\n')[0] : error}`); return; }

  await withMarketState(async () => {
    const world = marketWorld({ [OFFICIAL]: market.files }, { boxVersion: '99.0.0' });
    const warnings: any[] = [];
    const apps = (await world.catalog.fetchAvailableApps((warning: unknown) => warnings.push(warning))).filter((app: any) => app.integration === 'basic');
    assert.deepEqual(warnings.filter((warning) => !/This channel has no/.test(warning.message)), [], 'every catalog app loads from its bundle');
    assert.ok(apps.length >= 30, `${apps.length} apps`);
    for (const app of apps) {
      // As the catalog tar reader loaded it: the manifest and every file under setup/.
      const folder = path.join(marketRoot, 'apps', app.id);
      const setups: Record<string, string> = {};
      if (existsSync(path.join(folder, 'setup'))) {
        for (const name of (await import('node:fs')).readdirSync(path.join(folder, 'setup'))) setups[`setup/${name}`] = readFileSync(path.join(folder, 'setup', name), 'utf8');
      }
      const fromFiles = loadApp({ manifest: readFileSync(path.join(folder, 'youeye-app.yaml'), 'utf8'), setups });
      assert.equal(app.manifestDigest, fromFiles.frozen!.digest, app.id);
      assert.equal(app.manifestPath, `apps/${app.id}/youeye-app.yaml`);
      if (fromFiles.metadata.iconUrl) assert.match(app.iconUrl, /^\/api\/market\/image\?source=official&file=h%2Ffiles%2F[0-9a-f]{64}\.[a-z]+$/, app.id);
    }
  })();
});
