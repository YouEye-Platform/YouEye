/**
 * Plan 10 Part D: nothing from a custom Market source or a URL installs, updates or takes over an app without the
 * owner's consent, and the official Market is the default wherever no source is named.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { stringify } from 'yaml';
import * as compile from '../src/lib/market/app-format/compile';
import * as parse from '../src/lib/market/app-format/parse';
import * as partialCatalog from '../src/lib/market/partial-catalog';
import * as routing from '../src/lib/market/update-routing';
import * as version from '../src/lib/version';
import { appFixture, appYAML } from './fixtures/app-format';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const nodeRequire = createRequire(import.meta.url);

/** Run a source file with its imports replaced. Node built-ins pass through; anything else unmocked throws on use. */
function load(file: string, mocks: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'exports', 'module', output)((name: string) => {
    if (name in mocks) return mocks[name];
    if (/^(node:)?(fs|fs\/promises|path|crypto)$/.test(name)) return nodeRequire(name);
    return new Proxy({}, { get: (_target, property) => {
      if (property === '__esModule') return true;
      return () => { throw new Error(`Unexpected use of ${name}.${String(property)} in ${file}`); };
    } });
  }, module.exports, module);
  return module.exports;
}

/**
 * The real source module, with its /var/lib/youeye files in a temporary directory. `installed` are the installed apps
 * it sees (their recorded source ids); `writes` counts writes of the source list.
 */
function sourceModule(directory: string, seen: { installed?: () => Array<Record<string, unknown>>; writes?: string[] } = {}) {
  const fsp = nodeRequire('node:fs/promises');
  const map = (file: string) => file.startsWith('/var/lib/youeye') ? path.join(directory, file.slice('/var/lib/youeye'.length)) : file;
  return load('src/lib/market/source.ts', {
    'fs/promises': {
      mkdir: (file: string, options: unknown) => fsp.mkdir(map(file), options),
      readFile: (file: string, encoding: string) => fsp.readFile(map(file), encoding),
      writeFile: (file: string, data: string, options: unknown) => fsp.writeFile(map(file), data, options),
      rename: (from: string, to: string) => { seen.writes?.push(from); return fsp.rename(map(from), map(to)); },
    },
    fs: { existsSync: (file: string) => existsSync(map(file)) },
    './update-routing': routing,
    './installed-apps': { getAllInstalledApps: async () => seen.installed?.() ?? [] },
  });
}

function withDirectory(work: (directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'youeye-source-consent-'));
    try { await work(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
  };
}

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const next = { NextResponse: { json } };
const admin = {
  requireAdmin: async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } }),
  requireAdminCsrf: async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } }),
};
const request = (body: unknown, url = 'https://cp.example.test/api') =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const SETUP_A = stringify({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/health' } }] });
const SETUP_B = stringify({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/ready' } }] });

// Three sources: the official one, a legacy custom source added before consent existed (first by priority, never
// accepted) and a custom source the owner accepted.
const LEGACY = 'https://git.example.test/stranger/market';
const TRUSTED = 'https://git.example.test/friend/market';
function seedSources(directory: string) {
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true, trust: 'official' },
    { id: 'legacy', name: 'Stranger', repo_url: LEGACY, branch: 'main', enabled: true, priority: 1, trust: 'custom' },
    { id: 'trusted', name: 'Friend', repo_url: TRUSTED, branch: 'main', enabled: true, priority: 2, trust: 'custom',
      accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
}

/** The real catalog module over the real (temporary) source list: the official catalog.tar and two custom repos. */
function catalogModule(sources: Record<string, any>) {
  const official = new Map<string, Buffer>([
    ['catalog.yaml', Buffer.from('schema: youeye.catalog.v1\n')],
    ['apps/demo/youeye-app.yaml', Buffer.from(appYAML({ version: '1.0.0' }))],
  ]);
  const repo = (versionText: string) => ({
    'catalog.yaml': 'schema: youeye.catalog.v1\n',
    'catalog.json': JSON.stringify({ schema: 'youeye.catalog-index.v1', apps: ['demo'], bundles: ['pair'] }),
    'apps/demo/youeye-app.yaml': appYAML({ version: versionText }),
    'bundles/pair/bundle.yaml': stringify({ schema: 'youeye.bundle.v1', id: 'pair', name: 'Pair', description: 'd', members: ['demo'] }),
  });
  const repos: Record<string, Record<string, string>> = {
    [`${LEGACY}/raw/branch/main/`]: repo('3.0.0'),
    [`${TRUSTED}/raw/branch/main/`]: repo('2.0.0'),
    [`${TRUSTED}/raw/branch/dev/`]: repo('2.5.0'),
  };
  return load('src/lib/market/catalog.ts', {
    './catalog-release': {
      officialCatalogFile: async (file: string) => official.get(file) ?? Promise.reject(new Error('missing')),
      readAcceptedCatalog: async () => ({ files: official }),
      refreshOfficialCatalog: async () => ({ files: official }),
    },
    './native-artifact': {},
    '../releases/channel-index': { describeReleaseError: (error: unknown) => String(error) },
    '../releases/cache': {
      releaseCacheFetch: async (url: string) => {
        const base = Object.keys(repos).find((prefix) => url.startsWith(prefix));
        const file = base ? repos[base][decodeURIComponent(url.slice(base.length))] : undefined;
        return file === undefined ? new Response('', { status: 404 }) : new Response(file);
      },
    },
    './partial-catalog': partialCatalog,
    './app-format/compile': compile,
    './app-format/parse': parse,
    './source': sources,
  });
}

// ─── D1: consent is recorded by the server only ──────────────────────────────

test('a source is added only with acceptRisk; the list edit cannot add, accept or keep an accepted source retargeted',
  withDirectory(async (directory) => {
    const sources = sourceModule(directory);
    const route = load('src/app/api/market/source/route.ts', {
      'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
      '@/lib/market/catalog-release': { catalogReleaseDisplay: async () => null },
      '@/lib/market/catalog': { clearCatalogCache() {} },
    });
    const accept = load('src/app/api/market/source/accept/route.ts', {
      'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
      '@/lib/market/catalog': { clearCatalogCache() {} },
    });
    const list = async () => (await sources.getConfiguredMarketSources()) as Array<Record<string, any>>;

    const refused = await route.POST(request({ repo_url: TRUSTED }));
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /not checked by YouEye/);
    assert.deepEqual((await list()).map((source) => source.id), ['official']);

    const added = await route.POST(request({ repo_url: TRUSTED, id: 'andrew-test', branch: 'dev', acceptRisk: true }));
    assert.equal(added.status, 200);
    const [, andrew] = await list();
    assert.equal(andrew.id, 'andrew-test');
    assert.equal(andrew.branch, 'dev');
    assert.match(andrew.accepted_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await route.POST(request({ repo_url: TRUSTED, branch: 'dev', acceptRisk: true }))).status, 400, 'same repo and branch twice');

    // The PATCH cannot create a source, accepted or not.
    const patch = (active_sources: unknown[]) => route.PATCH(new Request('https://cp.example.test/api', {
      method: 'PATCH', body: JSON.stringify({ active_sources }) }));
    const create = await patch([...await list(), { id: 'evil', repo_url: LEGACY, accepted_at: '2026-01-01T00:00:00Z' }]);
    assert.equal(create.status, 400);
    assert.match((await create.json()).error, /does not exist/);
    assert.deepEqual((await list()).map((source) => source.id), ['official', 'andrew-test']);

    // A source from before consent existed: the PATCH cannot accept it; the accept call can.
    writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
      ...(await list()).map((source) => ({ ...source })),
      { id: 'legacy', name: 'Stranger', repo_url: LEGACY, branch: 'main', enabled: true, priority: 5, trust: 'custom' },
    ] }));
    assert.equal((await patch((await list()).map((source) => ({ ...source, accepted_at: '2026-01-01T00:00:00Z' })))).status, 200);
    assert.equal((await list()).find((source) => source.id === 'legacy')!.accepted_at, undefined);

    // Enable, disable and reorder keep the acceptance; a new address or branch under the same id drops it.
    const toggled = await patch((await list()).map((source) => ({ ...source, enabled: source.id !== 'official' })));
    assert.equal(toggled.status, 200);
    assert.equal((await list()).find((source) => source.id === 'official')!.enabled, false);
    assert.ok((await list()).find((source) => source.id === 'andrew-test')!.accepted_at);
    await patch((await list()).map((source) => source.id === 'andrew-test' ? { ...source, branch: 'main' } : source));
    assert.equal((await list()).find((source) => source.id === 'andrew-test')!.accepted_at, undefined, 'branch change');
    assert.equal((await accept.POST(request({ id: 'andrew-test' }))).status, 200);
    await patch((await list()).map((source) => source.id === 'andrew-test' ? { ...source, repo_url: LEGACY } : source));
    const retargeted = (await list()).find((source) => source.id === 'andrew-test')!;
    assert.equal(retargeted.repo_url, LEGACY);
    assert.equal(retargeted.accepted_at, undefined, 'address change');
    // Removing works; the official source is always kept.
    await patch((await list()).filter((source) => source.id === 'legacy'));
    assert.deepEqual((await list()).map((source) => source.id).sort(), ['legacy', 'official']);

    assert.equal((await accept.POST(request({ id: 'legacy' }))).status, 200);
    assert.ok((await list()).find((source) => source.id === 'legacy')!.accepted_at);
    assert.equal((await accept.POST(request({ id: 'official' }))).status, 400);
    assert.equal((await accept.POST(request({ id: 'nope' }))).status, 404);
  }));

// ─── D2/D3: one rule, official by default ────────────────────────────────────

test('installs resolve the official Market by default and never an unaccepted source', withDirectory(async (directory) => {
  seedSources(directory);
  const sources = sourceModule(directory);
  const catalog = catalogModule(sources);

  // "legacy" is the first enabled source by priority; without a named source the official Market still wins.
  const byDefault = await catalog.resolveCatalogApp('demo');
  assert.equal(byDefault.source.id, 'official');
  assert.equal(byDefault.manifest.version, '1.0.0');
  await assert.rejects(catalog.resolveCatalogApp('demo', 'legacy'),
    (error: any) => error.code === 'source-not-accepted' && /not accepted/.test(error.message));
  const trusted = await catalog.resolveCatalogApp('demo', 'trusted');
  assert.equal(trusted.source.id, 'trusted');
  assert.equal(trusted.manifest.version, '2.0.0');
  await assert.rejects(catalog.resolveCatalogApp('demo', 'missing'), (error: any) => error.code === 'source-unavailable');

  // With the official Market turned off, the first enabled source is a custom one: it is still never the default.
  const list = await sources.getConfiguredMarketSources();
  await sources.updateMarketSourceList(list.map((source: any) => ({ ...source, enabled: source.id !== 'official' })));
  await assert.rejects(catalog.resolveCatalogApp('demo'), (error: any) => error.code === 'source-unavailable' && /turned off/.test(error.message));
  await sources.updateMarketSourceList(list);

  // Listing stays allowed, with the reason attached.
  const apps = await catalog.fetchAvailableApps();
  assert.deepEqual(apps.map((app: any) => [app.sourceId, app.sourceNotAccepted ?? false]).sort(),
    [['legacy', true], ['official', false], ['trusted', false]]);
  const bundles = await catalog.fetchBundles();
  assert.deepEqual(bundles.map((bundle: any) => [bundle.sourceId, bundle.sourceNotAccepted ?? false]), [['legacy', true]]);
  assert.equal(await catalog.fetchBundle('pair'), null, 'a bundle without a named source is the official one');
  assert.equal((await catalog.fetchBundle('pair', 'legacy')).sourceId, 'legacy');
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
    '@/lib/market/update-admission': { withUserOperationLockWait: (work: () => unknown) => Promise.resolve().then(work) },
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
    const sources = sourceModule(directory);
    const { installs, post } = installRoute(catalogModule(sources), sources);

    assert.equal((await post({ appId: 'demo', sourceName: 'Evil', catalogKey: 'legacy:app:demo', sourceRepoUrl: LEGACY })).status, 200);
    assert.equal(installs[0].sourceId, 'official');
    assert.equal(installs[0].catalogKey, 'official:app:demo');
    assert.equal(installs[0].sourceName, 'Official YouEye Market');
    assert.equal(installs[0].sourceRepoUrl, undefined);

    const refused = await post({ appId: 'demo', sourceId: 'legacy' });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'source-not-accepted');
    assert.equal(installs.length, 1);

    assert.equal((await post({ appId: 'demo', sourceId: 'trusted' })).status, 200);
    assert.equal(installs[1].sourceId, 'trusted');
    assert.equal(installs[1].sourceRepoUrl, TRUSTED);
  }));

test('an app added by URL installs only with its own flags', withDirectory(async (directory) => {
  const sources = sourceModule(directory);
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
  const sources = sourceModule(directory);
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
    '@/lib/market/update-admission': { withAppLifecycle: lifecycle, withUserOperationLockWait: (work: () => unknown) => work() },
    '@/lib/http/lifecycle-busy': lifecycleBusy,
    '@/lib/market/install-tracker': { logOperationFailure() {} },
  };
}

test('switching an installed app to another source needs the same consent as installing from it', withDirectory(async (directory) => {
  seedSources(directory);
  const sources = sourceModule(directory);
  let metadata: Record<string, any> = { appId: 'demo', integration: 'basic', sourceId: 'official', manifestDigest: 'sha256:installed',
    installedVersion: '1.0.0', subdomain: 'demo' };
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
  assert.equal(metadata.manifestDigest, 'sha256:installed', 'the installed copy is unchanged until the next update');
  assert.equal((await patch({ sourceId: 'direct:abc', acceptUnverifiedPublisher: true, allowSetup: true })).status, 200);
  assert.equal(metadata.sourceId, 'direct:abc');
  assert.deepEqual(sourceUpdates.at(-1), ['demo', 'url', 'https://apps.example.test/y.yaml']);
}));

test('the source switch saves inside the app lock over the record it reads there, and answers busy with 409',
  withDirectory(async (directory) => {
    seedSources(directory);
    const sources = sourceModule(directory);
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
    assert.equal(metadata.manifestRepo, 'friend/market', 'the switch records where the source\'s manifests are read from');
    assert.equal(metadata.manifestBranch, 'main');

    busy = true;
    const refused = await patch({ sourceId: 'official' });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'operation_in_progress');
    assert.equal(metadata.sourceId, 'trusted');
  }));

// ─── An app follows its source's repository, not just its id ────────────────

const FOREIGN = 'https://git.example.test/stranger/market';

/**
 * App "demo" 1.0.0 installed from TRUSTED as source "custom-1", with the real source list, catalog, update check,
 * updater and source switch route over it.
 */
function repositoryScenario(directory: string) {
  mkdirSync(path.join(directory, 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true, trust: 'official' },
    { id: 'custom-1', name: 'Friend', repo_url: TRUSTED, branch: 'main', enabled: true, priority: 1, trust: 'custom',
      accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
  let metadata: Record<string, any> = { appId: 'demo', integration: 'basic', itemKind: 'app', lifecycleState: 'active',
    sourceId: 'custom-1', sourceName: 'Friend', catalogKey: 'custom-1:app:demo', sourceRepoUrl: TRUSTED,
    manifestPath: 'apps/demo/youeye-app.yaml', manifestRepo: 'friend/market', manifestBranch: 'main',
    manifestDigest: 'sha256:installed', installedVersion: '1.0.0', subdomain: 'demo', serviceCredentialState: 'ready', containers: [] };
  const metadataModule = {
    readInstallMetadata: async () => structuredClone(metadata),
    saveInstallMetadata: async (value: any) => { metadata = structuredClone(value); },
    listInstalledApps: async () => [],
  };
  // eslint-disable-next-line prefer-const
  let apps: Record<string, any>;
  const sources = sourceModule(directory, { installed: () => apps.getAllInstalledApps() });
  const catalog = catalogModule(sources);
  apps = load('src/lib/market/installed-apps.ts', {
    '@/lib/storage/json-store': {
      statePath: (name: string) => path.join(directory, 'state', name),
      writeJSON: async (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }),
    },
    'node:fs': nodeRequire('node:fs'), 'node:path': nodeRequire('node:path'),
    './update-executor-lock': nodeRequire(path.join(root, 'src/lib/market/update-executor-lock.ts')),
    './update-admission': { isAppUpdateReserved: () => false },
    './metadata': metadataModule,
    './catalog': { fetchCatalog: async () => ({ apps: [], bundles: [] }), resolveCatalogApp: catalog.resolveCatalogApp },
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
  const listRoute = load('src/app/api/market/source/route.ts', {
    'next/server': next, '@/lib/auth/rbac': admin, '@/lib/market/source': sources,
    '@/lib/market/catalog-release': { catalogReleaseDisplay: async () => null },
    '@/lib/market/catalog': { clearCatalogCache() {} },
  });
  return {
    sources,
    metadata: () => metadata,
    install: () => apps.upsertInstalledApp({ appId: 'demo', type: 'market', installedVersion: '1.0.0', subdomain: 'demo',
      catalogKey: 'custom-1:app:demo', sourceId: 'custom-1', sourceName: 'Friend', sourceRepoUrl: TRUSTED }),
    check: async () => { await apps.checkForUpdates(); return (await apps.getInstalledApp('demo')) as Record<string, any>; },
    update: () => updaterModule.updateMarketApp({ appId: 'demo' }, () => {}),
    switchTo: (sourceId: string) => switchRoute.PATCH(new Request('https://cp.example.test/api', {
      method: 'PATCH', body: JSON.stringify({ sourceId }) }), { params: Promise.resolve({ appId: 'demo' }) }),
    editList: (active_sources: unknown[]) => listRoute.PATCH(new Request('https://cp.example.test/api', {
      method: 'PATCH', body: JSON.stringify({ active_sources }) })),
    addSource: (body: Record<string, unknown>) => listRoute.POST(request({ acceptRisk: true, ...body })),
  };
}

const sourceChanged = (error: any) => error.code === 'source-changed'
  && /installed from https:\/\/git\.example\.test\/friend\/market; the Market source "\w+" now points at https:\/\/git\.example\.test\/stranger\/market/.test(error.message);

test('a removed source\'s id is not handed out again while an installed app records it', withDirectory(async (directory) => {
  const scenario = repositoryScenario(directory);
  await scenario.install();
  assert.equal((await scenario.check()).updateAvailable, true, 'custom-1 (TRUSTED) offers 2.0.0');
  // Remove the source the app came from, then add another repository: it gets a new id.
  const list = await scenario.sources.getConfiguredMarketSources();
  assert.equal((await scenario.editList(list.filter((source: any) => source.id === 'official'))).status, 200);
  const added = await scenario.addSource({ repo_url: FOREIGN });
  assert.equal(added.status, 200);
  assert.equal((await added.json()).source.id, 'custom-2', 'custom-1 is still recorded by demo');
  // A chosen id that the app records for another repository is refused; for the same repository it is allowed.
  const taken = await scenario.addSource({ repo_url: FOREIGN, branch: 'dev', id: 'custom-1' });
  assert.equal(taken.status, 400);
  assert.match((await taken.json()).error, /still records Market source "custom-1" for https:\/\/git\.example\.test\/friend\/market/);
  assert.equal((await scenario.addSource({ repo_url: `${TRUSTED}.git`, id: 'custom-1' })).status, 200, 'the same repository again');
  // Generation skips recorded ids and fills a gap otherwise; "direct" is reserved like "official".
  const now = '2026-11-18T12:00:00.000Z';
  const official = [scenario.sources.officialMarketSource()];
  assert.equal(scenario.sources.withAddedMarketSource(official, { repo_url: FOREIGN }, now, [{ sourceId: 'custom-1' }, { sourceId: 'custom-2' }]).at(-1).id, 'custom-3');
  assert.equal(scenario.sources.withAddedMarketSource(official, { repo_url: FOREIGN }, now).at(-1).id, 'custom-1');
  for (const id of ['direct', 'official']) {
    assert.throws(() => scenario.sources.withAddedMarketSource(official, { repo_url: FOREIGN, id }, now), /not "official" or "direct"/);
  }
}));

test('an app does not take updates from another repository under its source id until it is switched there',
  withDirectory(async (directory) => {
    const scenario = repositoryScenario(directory);
    await scenario.install();
    // The id custom-1 now names another repository (as an older Control Panel reused it after the source was removed).
    writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
      { id: 'official', enabled: true, trust: 'official' },
      { id: 'custom-1', name: 'Stranger', repo_url: FOREIGN, branch: 'main', enabled: true, priority: 1, trust: 'custom',
        accepted_at: '2026-11-18T11:00:00.000Z' },
    ] }));
    const blocked = await scenario.check();
    assert.equal(blocked.updateAvailable, false, 'FOREIGN\'s 3.0.0 is not offered');
    assert.equal(blocked.catalogVersion, null);
    assert.equal(blocked.updateBlocked.code, 'source-changed');
    assert.ok(sourceChanged({ code: blocked.updateBlocked.code, message: blocked.updateBlocked.message }), blocked.updateBlocked.message);
    assert.equal(blocked.sourceRepoUrl, TRUSTED, 'the check does not re-record the repository');
    await assert.rejects(scenario.update(), sourceChanged);
    assert.equal(scenario.metadata().installedVersion, '1.0.0');

    // The owner switches the app to the source on purpose (it is accepted): its updates come from there now.
    assert.equal((await scenario.switchTo('custom-1')).status, 200);
    assert.equal(scenario.metadata().sourceRepoUrl, FOREIGN);
    assert.equal(scenario.metadata().manifestRepo, 'stranger/market');
    const offered = await scenario.check();
    assert.equal(offered.updateAvailable, true);
    assert.equal(offered.catalogVersion, '3.0.0');
    assert.equal(offered.updateBlocked, null);
    assert.equal((await scenario.update()).errorCode, 'requires-newer-youeye', 'past the source checks');
  }));

test('re-pointing a source (address or branch) and accepting it again does not move its installed apps',
  withDirectory(async (directory) => {
    const scenario = repositoryScenario(directory);
    await scenario.install();
    const retarget = async (change: Record<string, string>) => {
      const list = await scenario.sources.getConfiguredMarketSources();
      assert.equal((await scenario.editList(list.map((source: any) => source.id === 'custom-1' ? { ...source, ...change } : source))).status, 200);
      await scenario.sources.acceptMarketSource('custom-1');
    };

    await retarget({ repo_url: FOREIGN });
    assert.equal((await scenario.check()).updateBlocked?.code, 'source-changed');
    await assert.rejects(scenario.update(), sourceChanged);

    // Back to the app's repository, but another branch: refused as well, naming the branches.
    await retarget({ repo_url: TRUSTED, branch: 'dev' });
    const blocked = await scenario.check();
    assert.equal(blocked.updateAvailable, false);
    assert.match(blocked.updateBlocked.message, /friend\/market \(branch main\); .* now points at .*friend\/market \(branch dev\)/);
    await assert.rejects(scenario.update(), (error: any) => error.code === 'source-changed');

    // The original address and branch: updates flow again without any switch.
    await retarget({ repo_url: TRUSTED, branch: 'main' });
    const offered = await scenario.check();
    assert.equal(offered.updateAvailable, true);
    assert.equal(offered.updateBlocked, null);
    // A switch to the dev branch records it; then dev's 2.5.0 is offered.
    await retarget({ repo_url: TRUSTED, branch: 'dev' });
    assert.equal((await scenario.switchTo('custom-1')).status, 200);
    assert.equal(scenario.metadata().manifestBranch, 'dev');
    assert.equal((await scenario.check()).catalogVersion, '2.5.0');
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

// ─── The source list file: one writer, no needless writes ────────────────────

test('two copies of the source module share one write chain; an unchanged resolution writes nothing',
  withDirectory(async (directory) => {
    seedSources(directory);
    const writes: string[] = [];
    const routes = sourceModule(directory, { writes });
    const background = sourceModule(directory, { writes });
    // Background resolutions interleaved with the owner's adds: none of them reverts another.
    await Promise.all([
      ...Array.from({ length: 6 }, (_, n) => routes.addMarketSource({ repo_url: `https://git.example.test/owner${n}/market` })),
      ...Array.from({ length: 6 }, (_, n) => background.recordMarketSourceResolution('trusted', { error: `fail ${n}` })),
    ]);
    const list = await routes.getConfiguredMarketSources();
    assert.equal(list.filter((source: any) => /owner\d/.test(source.repo_url)).length, 6, 'every add survives');
    assert.match(list.find((source: any) => source.id === 'trusted').refresh_error, /^fail \d$/);
    assert.equal(new Set(writes).size, writes.length, 'every write has its own temporary file');

    writes.length = 0;
    await background.recordMarketSourceResolution('trusted', { ok: true });
    await background.recordMarketSourceResolution('trusted', { ok: true });
    await routes.recordMarketSourceResolution('trusted', { ok: true });
    assert.equal(writes.length, 1, 'a success within a minute of the last one is not written again');
    await background.recordMarketSourceResolution('trusted', { error: 'down' });
    await background.recordMarketSourceResolution('trusted', { error: 'down' });
    assert.equal(writes.length, 2, 'the same error again is not written');
    await background.recordMarketSourceResolution('gone', { error: 'down' });
    assert.equal(writes.length, 2, 'a removed source is not written');
    const trusted = (await routes.getConfiguredMarketSources()).find((source: any) => source.id === 'trusted');
    assert.equal(trusted.refresh_error, 'down');
    assert.ok(trusted.resolved_at);
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
        resolveCatalogApp: async (appId: string, sourceId?: string) => {
          resolved.push([appId, sourceId]);
          const id = sourceId ?? 'official';
          return { source: { id, name: id, repo_url: '' }, entry: { id: appId, integration: 'basic', path: `apps/${appId}` },
            manifest: { version: '9.0.0', integration: 'basic' }, reference: { path: '', repo: '', branch: '', digest: '' },
            configuredSourceRepoUrls: [] };
        },
      },
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
    assert.equal(store.custom.sourceId, 'trusted');
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
    './catalog': { clearCatalogCache() {} },
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
  withDirectory(async (directory) => {
    const sources = sourceModule(directory);
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
