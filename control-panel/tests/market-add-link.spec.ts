/**
 * Plan 11 D1, D2, D5: "Add to YouEye" links. The page `/market/add?market=…|app=…` shows what a link would add; the
 * admin API behind it (`POST /api/market/add/preview`, CSRF-guarded) checks the link, reads the market or app with the Market's
 * fetchers and writes nothing. Adding is the existing guarded calls, and a signed-out owner comes back to the same
 * link after signing in.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { stringify } from 'yaml';
import * as urlApp from '../src/lib/market/url-app';
import * as compile from '../src/lib/market/app-format/compile';
import { OFFICIAL_MARKET_ADDRESSES } from '../src/lib/market/source';
import { safeOAuthReturn, oauthTransactionValue, readOAuthTransaction } from '../../shared/oauth-transaction';
import * as settingsPublicPath from '../src/lib/settings-public-path';
import { appYAML } from './fixtures/app-format';
import { buildFixtureMarket } from './fixtures/market';
import { load, marketWorld, root, withMarketState } from './fixtures/market-world';

const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
const next = { NextResponse: { json } };

const MARKET = 'https://markets.example.org/friend/';
const APP_URL = 'https://apps.example.org/demo/youeye-app.yaml';
const SETUP = stringify({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/health' } }] });

/** A market whose market.json names a homepage (market.json itself is not hashed; its index is). */
function marketWithHomepage(homepage: string | undefined) {
  const built = buildFixtureMarket({
    name: 'Friend’s <b>Market</b>', publisher: 'Friend', sequence: 1795000000, commit: 'abc12345',
    apps: [{ id: 'demo', version: '2.0.0', setups: { 'install.yaml': SETUP } }, { id: 'plain', version: '1.0.0' },
      { id: 'journal', version: '1.2.0', native: true }],
    // An index from before 0.6.20 named native apps of the channel: ignored, never counted.
    legacyNative: ['notes', 'wiki'],
  });
  const pointer = JSON.parse(built.files.get('market.json')!.toString('utf8'));
  if (homepage) pointer.homepage = homepage;
  built.files.set('market.json', Buffer.from(`${JSON.stringify(pointer)}\n`));
  return built.files;
}

/** An app at APP_URL with one setup file, served by a fake transport that records every request. */
function appHost() {
  const requests: string[] = [];
  const files: Record<string, string> = {
    '/demo/youeye-app.yaml': appYAML({ id: 'demo', name: 'Demo', version: '3.1.0' }),
    '/demo/setup/install.yaml': SETUP,
  };
  const deps: urlApp.UrlFetchDeps = {
    resolve: async () => ['93.184.216.34'],
    get: async (url) => {
      requests.push(url.toString());
      const body = files[url.pathname];
      return body === undefined ? { status: 404, contentType: 'text/plain', body: 'not found' } : { status: 200, contentType: 'text/yaml', body };
    },
  };
  return { deps, requests };
}

interface Fixture {
  directory: string;
  directDirectory: string;
  state: { session: Record<string, unknown> | null; csrf: boolean };
  route: Record<string, any>;
  hosts: ReturnType<typeof marketWorld>['hosts'];
  app: ReturnType<typeof appHost>;
  saves: number;
}

/** The real preview route over the real rbac, source list, store, fetchers and Added-app store (in temporary folders). */
function fixture(directory: string, homepage?: string): Fixture {
  const world = marketWorld({ [MARKET]: marketWithHomepage(homepage), [OFFICIAL_MARKET_ADDRESSES.main]: marketWithHomepage(undefined) });
  const state: Fixture['state'] = { session: { username: 'owner', isAdmin: true, authMethod: 'sso' }, csrf: true };
  const rbac = load('src/lib/auth/rbac.ts', {
    'next/server': next,
    // The real verifyCSRFToken passes CLI-token requests without a CSRF token (lib/auth/session.ts).
    './session': { getSession: async () => state.session, verifyCSRFToken: async () => state.csrf || state.session?.authMethod === 'cli' },
  });
  const app = appHost();
  const fetchUrlApp = (url: string) => urlApp.fetchUrlApp(url, app.deps);
  const directDirectory = mkdtempSync(path.join(tmpdir(), 'youeye-direct-'));
  const jsonStore = load('src/lib/storage/json-store.ts', {});
  const counters = { saves: 0 };
  const directApps = load('src/lib/market/direct-apps.ts', {
    '@/lib/storage/json-store': { ...jsonStore, statePath: (name: string) => path.join(directDirectory, name) },
    './catalog': { manifestToMarketApp: () => ({}) },
    './app-format/compile': compile,
    './url-app': { ...urlApp, fetchUrlApp },
  });
  const linkParameter = load('src/app/api/market/add/link-parameter.ts', {
    '@/components/market/sign-in-location': signInLocation(),
    '@/lib/market/source': world.sources,
    '@/lib/market/url-app': urlApp,
  });
  const route = load('src/app/api/market/add/preview/route.ts', {
    'next/server': next,
    '@/lib/auth/rbac': rbac,
    '@/lib/market/direct-apps': {
      ...directApps,
      saveDirectMarketApp: async (...args: unknown[]) => { counters.saves++; return directApps.saveDirectMarketApp(...args); },
    },
    '@/lib/market/market-store': world.store,
    '@/lib/market/source': world.sources,
    '@/lib/market/url-app': { ...urlApp, fetchUrlApp },
    '../link-parameter': linkParameter,
  });
  return {
    directory, directDirectory, state, route, hosts: world.hosts, app,
    get saves() { return counters.saves; },
  } as Fixture;
}

const preview = (f: Fixture, query: string) => f.route.POST(new Request(`https://control.example.test/api/market/add/preview?${query}`, { method: 'POST' }));

/** The real sign-in location module (with its one import). */
function signInLocation() {
  return load('src/components/market/sign-in-location.ts', { '@/lib/settings-public-path': settingsPublicPath });
}
const q = (name: string, value: string) => `${name}=${encodeURIComponent(value)}`;

/** Every file under a folder, with its bytes (to prove a preview changed nothing). */
function snapshot(directory: string): Record<string, string> {
  if (!existsSync(directory)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(directory, file)] = readFileSync(file, 'base64');
  }
  return out;
}

test('the preview API refuses signed-out and non-admin callers and takes the CLI token', withMarketState(async (directory) => {
  const f = fixture(directory);
  f.state.session = null;
  assert.equal((await preview(f, q('market', MARKET))).status, 401);
  f.state.session = { username: 'reader', isAdmin: false, authMethod: 'sso' };
  assert.equal((await preview(f, q('market', MARKET))).status, 403);
  // An admin's browser without the CSRF token (a page the admin merely visits) cannot make the box fetch.
  f.state.session = { username: 'owner', isAdmin: true, authMethod: 'sso' };
  f.state.csrf = false;
  const forged = await preview(f, q('market', MARKET));
  assert.equal(forged.status, 403);
  assert.match((await forged.json()).error, /CSRF/);
  assert.equal(f.hosts.requests.length, 0, 'nothing is fetched for a caller who may not add');
  // The CLI token is a synthetic admin session (lib/auth/session.ts getSession) and needs no CSRF token.
  f.state.session = { username: 'cli', isAdmin: true, authMethod: 'cli', groups: ['sudo', 'cli'] };
  const answer = await preview(f, q('market', MARKET));
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).kind, 'market');
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('the preview API checks the link before anything is fetched', withMarketState(async (directory) => {
  const f = fixture(directory);
  const refused = async (query: string, pattern: RegExp) => {
    const answer = await preview(f, query);
    assert.equal(answer.status, 400, query);
    assert.match((await answer.json()).error, pattern, query);
  };
  await refused('', /exactly one market or one app/);
  await refused(`${q('market', MARKET)}&${q('app', APP_URL)}`, /exactly one/);
  await refused(`${q('market', MARKET)}&${q('market', MARKET)}`, /exactly one/);
  await refused(q('market', ''), /no address/);
  await refused(q('market', 'http://markets.example.org/friend/'), /https:\/\//);
  await refused(q('app', 'http://apps.example.org/demo/youeye-app.yaml'), /https:\/\//);
  await refused(q('market', 'https://user:secret@markets.example.org/friend/'), /user name or password/);
  await refused(q('app', 'https://user@apps.example.org/demo/youeye-app.yaml'), /user name or password/);
  await refused(q('market', `${MARKET}${'a'.repeat(2048)}`), /too long: it must stay within 2,048 characters once encoded/);
  for (const bad of ['\u0000', '\n', '\t', '\u007f', '\u0085', ' ', '\\']) {
    await refused(q('market', `https://markets.example.org/fr${bad}iend/`), /not allowed/);
  }
  await refused(q('market', 'not a url'), /not allowed|not a web address/);
  await refused(q('market', 'notaurl'), /not a web address/);
  await refused(q('market', 'https://192.168.1.5/market/'), /public server/);
  await refused(q('app', 'https://box.local/app/youeye-app.yaml'), /public server/);
  await refused(q('market', `${MARKET}?x=1`), /query or a fragment/);
  assert.equal(f.hosts.requests.length, 0);
  assert.equal(f.app.requests.length, 0);
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('the length limit is on the encoded return path: exactly 2,048 is accepted, one more is refused', withMarketState(async (directory) => {
  const f = fixture(directory);
  // `/market/add?market=` + the encoded address; the encoded prefix "https%3A%2F%2F…%2F" is longer than the address.
  const prefix = `/market/add?market=${encodeURIComponent(MARKET)}`;
  const long = `${MARKET}${'m'.repeat(2048 - prefix.length - '%2F'.length)}/`;
  assert.equal(`/market/add?market=${encodeURIComponent(long)}`.length, 2048);
  assert.ok(long.length < 2048 - 20, 'the raw address is well under the limit; its encoding is not');
  const answer = await preview(f, q('market', long));
  // Accepted as a link; the fake host has no market there.
  assert.equal(answer.status, 502);
  assert.match((await answer.json()).error, /market\.json: HTTP 404/);
  const tooLong = `${MARKET}${'m'.repeat(2048 - prefix.length - '%2F'.length + 1)}/`;
  const refused = await preview(f, q('market', tooLong));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /lost when you sign in/);
  // Characters that encode to three are counted as three: a short address of them is refused.
  const encoded = `${MARKET}${'é'.repeat(400)}/`;
  assert.ok(encoded.length < 500);
  assert.equal((await preview(f, q('market', encoded))).status, 400);
  // The limit is the one the sign-in route keeps (shared/oauth-transaction.ts).
  assert.equal(signInLocation().MAX_SIGN_IN_RETURN_PATH, 2048);
  assert.equal(safeOAuthReturn(`/${'a'.repeat(2047)}`, '/fallback'), `/${'a'.repeat(2047)}`);
  assert.equal(safeOAuthReturn(`/${'a'.repeat(2048)}`, '/fallback'), '/fallback');
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('at most two previews run at once; a third answers 429 and nothing of it is fetched', withMarketState(async (directory) => {
  const f = fixture(directory);
  const get = f.app.deps.get;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let waiting = 0;
  f.app.deps.get = async (url) => { waiting++; await gate; return get(url); };
  const first = preview(f, q('app', APP_URL));
  const second = preview(f, q('app', APP_URL));
  while (waiting < 2) await new Promise((resolve) => setImmediate(resolve));
  const third = await preview(f, q('app', APP_URL));
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /Try again in a moment/);
  assert.equal(waiting, 2);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  // Slots are given back, after a failure too.
  assert.equal((await preview(f, q('app', 'https://apps.example.org/other/youeye-app.yaml'))).status, 502);
  assert.equal((await preview(f, q('app', APP_URL))).status, 200);
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('a market preview shows the market’s own words and counts, and writes nothing', withMarketState(async (directory) => {
  const f = fixture(directory, 'https://friend.example.org/about');
  const before = snapshot(directory);
  const answer = await preview(f, q('market', `${MARKET}market.json`));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    kind: 'market', address: MARKET, name: 'Friend’s <b>Market</b>', publisher: 'Friend',
    homepage: 'https://friend.example.org/about', apps: 3, apps_with_setup: 1, native: 1, already_added: null,
  }, 'every app, its native one too (any market may offer native apps, YE-142); the old native ids are not counted');
  assert.deepEqual(snapshot(directory), before, 'no source list, no market store');
  assert.equal(existsSync(path.join(directory, 'market-sources.json')), false);
  assert.equal(existsSync(path.join(directory, 'markets')), false);
  // The pointer and the index only: no bundle, no picture.
  const paths = f.hosts.take();
  assert.equal(paths[0], 'market.json');
  assert.deepEqual(paths.slice(1).map((requested) => requested.replace(/[0-9a-f]{64}/, '<sha>')), ['h/index/<sha>.json']);

  // The official Market (the box's lane) is always on the box; it is counted the same way.
  const official = await (await preview(f, q('market', OFFICIAL_MARKET_ADDRESSES.main))).json();
  assert.equal(official.already_added, 'official');
  assert.equal('homepage' in official, false);
  assert.equal(official.apps, 3, 'every app, as `youeye market list` counts them');
  assert.equal(official.native, 1);
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('a homepage is returned only when it is an https address', withMarketState(async (directory) => {
  for (const homepage of ['http://friend.example.org/', 'javascript:alert(1)', 'https://user:pw@friend.example.org/', 'not a url']) {
    const f = fixture(directory, homepage);
    const body = await (await preview(f, q('market', MARKET))).json();
    assert.equal(body.kind, 'market', homepage);
    assert.equal('homepage' in body, false, homepage);
    rmSync(f.directDirectory, { recursive: true, force: true });
  }
}));

test('a market already on the box is named by its source id', withMarketState(async (directory) => {
  writeFileSync(path.join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: true },
    { id: 'friend', name: 'Friend', url: MARKET, enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
  const f = fixture(directory);
  const before = snapshot(directory);
  const body = await (await preview(f, q('market', MARKET.slice(0, -1)))).json();
  assert.equal(body.already_added, 'friend');
  assert.deepEqual(snapshot(directory), before);
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('an app preview reads the manifest and its setup files and adds nothing', withMarketState(async (directory) => {
  const f = fixture(directory);
  const answer = await preview(f, q('app', APP_URL));
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.kind, 'app');
  assert.equal(body.url, APP_URL);
  assert.equal(body.host, 'apps.example.org');
  assert.equal(body.id, 'demo');
  assert.equal(body.name, 'Demo');
  assert.equal(body.version, '3.1.0');
  assert.equal(body.images.length, 1);
  assert.match(body.images[0], /^ghcr\.io\/example\/demo@sha256:/);
  assert.deepEqual(body.setups, ['setup/install.yaml']);
  assert.equal(body.already_added, null);
  assert.equal(f.saves, 0, 'saveDirectMarketApp is never called by a preview');
  assert.deepEqual(snapshot(f.directDirectory), {}, 'the Added-app store is untouched');
  assert.deepEqual(snapshot(directory), {});

  // Once the app is added (the guarded add call), the preview says so and still writes nothing.
  const directApps = load('src/lib/market/direct-apps.ts', {
    '@/lib/storage/json-store': { ...load('src/lib/storage/json-store.ts', {}), statePath: (name: string) => path.join(f.directDirectory, name) },
    './catalog': { manifestToMarketApp: () => ({}) }, './app-format/compile': compile, './url-app': urlApp,
  });
  const saved = await directApps.saveDirectMarketApp({ manifestUrl: APP_URL, manifest: await urlApp.fetchUrlApp(APP_URL, f.app.deps) });
  const stored = snapshot(f.directDirectory);
  const again = await (await preview(f, q('app', APP_URL))).json();
  assert.equal(again.already_added, saved.sourceId);
  assert.deepEqual(snapshot(f.directDirectory), stored);

  // A repository address stands for its manifest, the same way the add call reads it.
  const github = await preview(f, q('app', 'https://github.com/example/demo'));
  assert.equal(github.status, 502);
  assert.ok(f.app.requests.includes('https://raw.githubusercontent.com/example/demo/main/youeye-app.yaml'));
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('an official lane added as a custom market is refused by the preview with a plain message, and the page shows it without Add', withMarketState(async (directory) => {
  const f = fixture(directory);
  // The box follows the stable lane: the dev lane is the official Market, not a market to add.
  const lane = await preview(f, q('market', OFFICIAL_MARKET_ADDRESSES.dev));
  assert.ok(lane.status >= 400, String(lane.status));
  const body = await lane.json();
  assert.equal(typeof body.error, 'string');
  assert.match(body.error, /official YouEye Market/);
  assert.equal(body.kind, undefined);
  rmSync(f.directDirectory, { recursive: true, force: true });

  // The page: any answer that is not ok (or not a preview) becomes the plain error; the error view has no Add button.
  const page = readFileSync(path.join(root, 'src/app/market/add/page.tsx'), 'utf8');
  assert.match(page, /if \(!res\.ok \|\| \(data\.kind !== 'market' && data\.kind !== 'app'\)\) \{\s*const details = [^\n]*\n\s*setError\(typeof data\.error === 'string' \? `\$\{data\.error\}\$\{details\}`/);
  const errorView = page.slice(page.indexOf('if (error || !preview) {'), page.indexOf('const isMarket = preview.kind'));
  assert.ok(errorView.length > 0);
  assert.match(errorView, /role="alert"[^]*\{error\}/);
  assert.doesNotMatch(errorView, /<Button|onClick=\{add\}|authenticatedFetch|dangerouslySetInnerHTML/);
  // Add exists only after the error view returned, and only for a preview not already on the box.
  assert.ok(page.indexOf('<Button onClick={add}') > page.indexOf('if (error || !preview) {'));
}));

test('a market or app that cannot be read is a plain refusal', withMarketState(async (directory) => {
  const f = fixture(directory);
  const missing = await preview(f, q('market', 'https://markets.example.org/nothing/'));
  assert.equal(missing.status, 502);
  assert.match((await missing.json()).error, /market\.json: HTTP 404/);
  const notApp = await preview(f, q('app', 'https://apps.example.org/other/youeye-app.yaml'));
  assert.equal(notApp.status, 502);
  assert.match((await notApp.json()).error, /HTTP 404/);
  assert.deepEqual(snapshot(directory), {});
  rmSync(f.directDirectory, { recursive: true, force: true });
}));

test('the preview route only reads: it exports POST alone (GET is 405), and adding goes through the existing guarded routes', () => {
  const file = path.join(root, 'src/app/api/market/add/preview/route.ts');
  const source = readFileSync(file, 'utf8');
  const exported = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements
    .filter((statement) => (ts.getCombinedModifierFlags(statement as ts.Declaration) & ts.ModifierFlags.Export) !== 0)
    .flatMap((statement) => ts.isFunctionDeclaration(statement) ? [statement.name!.text]
      : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((declaration) => declaration.name.getText()) : ['?']);
  // Next answers 405 for a method a route does not export: a GET (an image tag, a link) cannot start a preview.
  assert.deepEqual(exported.sort(), ['POST', 'dynamic']);
  assert.match(source, /export async function POST\(request: Request\) \{\s*const auth = await requireAdminCsrf\(request\);/);
  assert.doesNotMatch(source, /saveDirectMarketApp|addMarketSource|refreshMarket|writeFile|mutateMarketSources/);
  assert.equal(existsSync(path.join(root, 'src/app/api/market/add/route.ts')), false, 'no write route of its own');

  const page = readFileSync(path.join(root, 'src/app/market/add/page.tsx'), 'utf8');
  assert.match(page, /^'use client';/);
  // Called after the page has rendered (an effect), with the CSRF-carrying fetch.
  assert.match(page, /useEffect\(\(\) => \{[^]*?authenticatedFetch\(`\/api\/market\/add\/preview\?\$\{query\}`, \{ method: 'POST', cache: 'no-store' \}\)/);
  assert.doesNotMatch(page, /[^d]fetch\(`\/api\/market\/add\/preview/);
  const sourcesPage = readFileSync(path.join(root, 'src/app/market/sources/page.tsx'), 'utf8');
  assert.match(sourcesPage, /authenticatedFetch\(`\/api\/market\/add\/preview\?market=\$\{encodeURIComponent\(newUrl\.trim\(\)\)\}`, \{ method: 'POST', cache: 'no-store' \}\)/);
  // Adding: the existing guarded calls with the CSRF-carrying fetch, the owner's consent sent explicitly.
  assert.match(page, /authenticatedFetch\('\/api\/market\/source', \{\s*method: 'POST'/);
  assert.match(page, /acceptRisk: true/);
  assert.match(page, /authenticatedFetch\('\/api\/market\/validate-url', \{\s*method: 'POST'/);
  assert.match(page, /addToMarket: true/);
  assert.match(page, /disabled=\{!trusted \|\| adding\}/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  // The source POST route keeps its guard.
  assert.match(readFileSync(path.join(root, 'src/app/api/market/source/route.ts'), 'utf8'), /export async function POST\(request: NextRequest\) \{\s*const auth = await requireAdminCsrf\(request\);/);
});

// ─── D2: a signed-out owner comes back to the same link ──────────────────────

test('the longest link the preview accepts survives the sign-in round trip', () => {
  const { addLinkParameter, addLinkReturnPath } = load('src/app/api/market/add/link-parameter.ts', {
    '@/components/market/sign-in-location': signInLocation(),
    '@/lib/market/source': { checkedMarketAddress: (value: string) => value },
    '@/lib/market/url-app': urlApp,
  });
  for (const name of ['market', 'app'] as const) {
    const base = name === 'market' ? 'https://markets.example.org/' : 'https://apps.example.org/';
    const tail = name === 'market' ? '/' : '/youeye-app.yaml';
    const filler = 2048 - addLinkReturnPath(name, `${base}${tail}`).length;
    const address = `${base}${'a'.repeat(filler)}${tail}`;
    assert.ok(!('error' in addLinkParameter(new URLSearchParams({ [name]: address }))), name);
    assert.match(addLinkParameter(new URLSearchParams({ [name]: `${base}${'a'.repeat(filler + 1)}${tail}` })).error, /too long/);
    // As my.youeye.me builds the link, and as the shell and the proxy keep it (pathname + search).
    const page = new URL(`https://control.example.test${addLinkReturnPath(name, address)}`);
    const returnTo = `${page.pathname}${page.search}`;
    assert.equal(returnTo.length, 2048);
    assert.equal(safeOAuthReturn(returnTo), returnTo);
    // /settings/api/auth/sso?redirect=… → the transaction cookie → the callback.
    const location = signInLocation().marketSignInLocation(true, page.pathname, page.search);
    const carried = safeOAuthReturn(new URL(location, 'https://control.example.test').searchParams.get('redirect'), '/');
    assert.equal(carried, returnTo);
    const state = 'f'.repeat(64);
    const cookie = oauthTransactionValue(state, carried);
    assert.ok(cookie.length <= 4096);
    assert.equal(readOAuthTransaction(cookie, state), returnTo);
    assert.equal(new URL(returnTo, 'https://control.example.test').searchParams.get(name), address);
  }
});

test('the Market shell signs in through the Control Panel’s own routes, as the proxy does for /market', () => {
  const redirect = signInLocation();
  const search = `?market=${encodeURIComponent('https://markets.example.org/friend/')}`;
  // On the box's name (YouEye ID): /settings/api/auth/sso, which Caddy sends to the Control Panel. A bare
  // /api/auth/sso is the dashboard's and would never renew the Control Panel's session (an endless reload).
  const url = new URL(redirect.marketSignInLocation(true, '/market/add', search), 'https://control.example.test');
  assert.equal(url.pathname, '/settings/api/auth/sso');
  assert.equal(url.searchParams.get('redirect'), `/market/add${search}`);
  // The box's own password sign-in (IP or .local, loopback).
  assert.equal(redirect.marketSignInLocation(false, '/market/add', search), '/settings/login');

  // The same as the proxy: /market is a Settings path there and goes to the same two routes.
  assert.equal(settingsPublicPath.isSettingsPath('/market/add'), true);
  const proxy = readFileSync(path.join(root, 'src/proxy.ts'), 'utf8');
  assert.match(proxy, /new URL\(settingsPath \? '\/settings\/api\/auth\/sso' : '\/api\/auth\/sso', request\.url\)/);
  assert.match(proxy, /new URL\(settingsPath \? '\/settings\/login' : '\/login', request\.url\)/);
  assert.match(proxy, /const returnTo = `\$\{request\.nextUrl\.pathname\}\$\{request\.nextUrl\.search\}`;/);
  assert.match(readFileSync(path.join(root, 'src/app/settings/api/auth/sso/route.ts'), 'utf8'), /export \{ GET \} from "@\/app\/api\/auth\/sso\/route";/);
  // Caddy sends /market and /settings to the Control Panel, and /api/auth/sso is not among its support paths.
  const caddy = readFileSync(path.join(root, 'src/lib/caddy/client.ts'), 'utf8');
  const support = caddy.slice(caddy.indexOf("'control-settings-support-route'"), caddy.indexOf("'control-pointer-assets-route'"));
  assert.doesNotMatch(support, /'\/api\/auth\/sso'|'\/api\/auth\/\*'/);

  const shell = readFileSync(path.join(root, 'src/components/control-surface/market-shell.tsx'), 'utf8');
  assert.match(shell, /if \(!session\) return <SignInRedirect/);
  assert.doesNotMatch(shell, /redirect\("\/settings\/login"\)/);
});

test('a page that comes back from sign-in still signed out shows a sign-in link instead of reloading', () => {
  const { marketSignInStep, signInAttempt, SIGN_IN_RETRY_WINDOW_MS } = signInLocation();
  const search = `?app=${encodeURIComponent(APP_URL)}`;
  const returnTo = `/market/add${search}`;
  const now = 1_800_000_000_000;
  for (const sso of [true, false]) {
    const expected = sso ? `/settings/api/auth/sso?redirect=${encodeURIComponent(returnTo)}` : '/settings/login';
    // First visit: one redirect, remembered.
    const first = marketSignInStep(sso, '/market/add', search, null, now);
    assert.deepEqual(first, { kind: 'redirect', location: expected, attempt: signInAttempt(returnTo, now) });
    // Back from that attempt without a session: a link, never another redirect.
    const back = marketSignInStep(sso, '/market/add', search, first.attempt, now + 5_000);
    assert.deepEqual(back, { kind: 'link', location: expected, reason: 'returned' });
    // An old attempt, or one for another page, does not stop a fresh redirect.
    assert.equal(marketSignInStep(sso, '/market/add', search, first.attempt, now + SIGN_IN_RETRY_WINDOW_MS).kind, 'redirect');
    assert.equal(marketSignInStep(sso, '/market', '', first.attempt, now + 5_000).kind, 'redirect');
    assert.equal(marketSignInStep(sso, '/market/add', search, 'not json', now).kind, 'redirect');
    // No storage: nothing tells a first visit from a return, so the owner clicks.
    assert.equal(marketSignInStep(sso, '/market/add', search, undefined, now).kind, 'link');
  }
  // A return path the sign-in route would drop is never sent: the owner is told, not silently sent elsewhere.
  const long = `?app=${'a'.repeat(2048)}`;
  assert.deepEqual(marketSignInStep(true, '/market/add', long, null, now),
    { kind: 'link', location: `/settings/api/auth/sso?redirect=${encodeURIComponent('/market/add')}`, reason: 'too-long' });

  // The component follows the step: it redirects only on 'redirect', after remembering the attempt, and clears the
  // marker when it shows the link (a click remembers a fresh attempt).
  const component = readFileSync(path.join(root, 'src/components/market/sign-in-redirect.tsx'), 'utf8');
  assert.match(component, /const next = marketSignInStep\(sso, window\.location\.pathname, window\.location\.search, storedAttempt\(\), Date\.now\(\)\);\s*if \(next\.kind === 'redirect'\) \{\s*rememberAttempt\(next\.attempt\);\s*window\.location\.replace\(next\.location\);/);
  assert.equal(component.match(/window\.location\.replace/g)?.length, 1);
  assert.match(component, /onClick=\{\(\) => rememberAttempt\(signInAttempt\(/);
});
