/**
 * Every Control Panel route handler is behind an admin check, or is listed here with the reason it isn't.
 *
 * Two layers protect a route: the proxy (`src/proxy.ts`) refuses any request without a valid session or CLI token,
 * except for its public routes; and the handler itself may check more (admin, CSRF, setup session, a secret).
 * - A handler under a public route must check something itself, or be in PUBLIC_HANDLERS with a reason.
 * - Any other handler must check for an admin itself, or be in STANDARD_USER_HANDLERS: any signed-in user, a standard
 *   user included, may call it. A session check alone is not an admin check (0.6.15: a session-only SQL console let
 *   any standard user run SQL and a root shell in youeye-postgres).
 * A handler "checks something" when its body, or a function in the same file that it calls, calls a check (or an
 * admin check), or when it calls a delegate that does. Re-exported handlers are judged by their source.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(process.env.CONTROL_PANEL_ROOT ?? process.cwd(), 'src');
const AUTH_CALL = /\b(getSession|requireAdmin|requireAdminCsrf|requireAuth|requireEmbedAdmin|getEmbedSession|validateEmbedSession|requireSetupSession|getIdentitySession|isValidCLIToken)\s*\(/;
// Admin checks: the helpers that refuse a non-admin, and a handler's own `if (!session?.isAdmin) return …` guard.
const ADMIN_CALL = /\b(requireAdmin|requireAdminCsrf|requireEmbedAdmin|requireSetupSession|isAdminSession)\s*\(|!\s*(?:\w+|\(await getSession\(\)\))\??\.isAdmin\b|return\s+\w+\??\.isAdmin\s*&&/;
// Imported functions that do the check for the handler that calls them (file: where they live).
const AUTH_DELEGATES: Record<string, string> = {
  handleMarketUpdate: 'lib/market/update-http.ts',
  checkUpdateStatusAccess: 'lib/updates/status-access.ts',
};

const PUBLIC_HANDLERS: Record<string, string> = {
  'GET /api/appliance/claim': 'claim status for the unclaimed box; the claim itself is rate-limited and one-time',
  'POST /api/appliance/claim': 'claiming the box: rate-limited, refused once an owner exists',
  'GET /api/auth/callback': 'OAuth callback: validates state and exchanges the code',
  'GET /api/auth/csrf': 'issues the CSRF cookie',
  'POST /api/auth/login': 'password sign-in: rate-limited, local setup surface only (proxy)',
  'GET /api/auth/mode': 'tells the sign-in page which sign-in method this host uses',
  'GET /api/auth/popup-close': 'static page that closes the SSO popup',
  'GET /api/auth/sso': 'starts SSO sign-in',
  'POST /api/auth/reset-owner': 'owner reset with the console code: rate-limited and same-origin',
  'GET /api/branding/favicon': 'public favicon',
  'POST /api/deploy/infrastructure': 'Spine first deploy: X-Deploy-Secret',
  'GET /api/deploy/infrastructure/jobs/[id]': 'Spine first deploy: X-Deploy-Secret',
  'POST /api/deploy/infrastructure/reconcile': 'Spine: X-Deploy-Secret',
  'POST /api/host-ip/migrate': 'Spine host IP change: X-Deploy-Secret',
  'POST /api/mail/send': 'SMTP relay for apps: UI bridge token or app service credential (validateAuth)',
  'GET /api/market/image': 'pictures an enabled, accepted market names, from the box\'s copy of it; anything else is 404 without a fetch',
  'GET /api/ping': 'liveness',
  'GET /api/setup/ca-cert': 'the box CA certificate, for trusting HTTPS during setup',
  'GET /api/setup/ca-fingerprint': 'the box CA fingerprint (local setup host only)',
  'GET /api/setup/check-dns': 'setup DNS check',
  'GET /api/setup/config': 'setup completion state for the setup pages',
  'GET /api/setup/profile': 'Apple configuration profile with the box CA',
  'GET /api/setup/server-address': 'the box address for setup (local setup host only)',
  'POST /api/telemetry/record': 'route counter fed by the proxy itself',
  'GET /application/o/[clientId]/.well-known/openid-configuration': 'OIDC discovery',
  'POST /application/o/revoke': 'OAuth revoke: client credentials',
  'POST /application/o/token': 'OAuth token: client credentials and auth code',
  'GET /application/o/userinfo': 'OIDC userinfo: bearer access token',
  'POST /application/o/userinfo': 'OIDC userinfo: bearer access token',
  'GET /forward-auth/caddy': 'Caddy forward auth: checks the identity session itself',
  'POST /identity/handoff': 'one-time setup handoff code',
  'GET /identity/login': 'YouEye ID sign-in page',
  'POST /identity/login': 'YouEye ID sign-in: rate-limited',
  'GET /oauth/jwks': 'public signing keys',
  'GET /embed/health': 'liveness of the embed surface',
  'GET /reset-owner': 'redirect to the owner reset page',
};

// Handlers a standard user may call. Reads and the user's own account only: anything that changes the box, or shows
// what other people do on it, is an admin's.
const STANDARD_USER_HANDLERS: Record<string, string> = {
  'GET /': 'redirects to the dashboard',
  'GET /api/ai/[...path]': 'Pointer management: the call carries the user\'s identity assertion and Pointer checks the role',
  'POST /api/ai/[...path]': 'Pointer management: the call carries the user\'s identity assertion and Pointer checks the role',
  'PUT /api/ai/[...path]': 'Pointer management: the call carries the user\'s identity assertion and Pointer checks the role',
  'PATCH /api/ai/[...path]': 'Pointer management: the call carries the user\'s identity assertion and Pointer checks the role',
  'DELETE /api/ai/[...path]': 'Pointer management: the call carries the user\'s identity assertion and Pointer checks the role',
  'POST /api/ai-proxy-test': 'tests the caller\'s own Pointer key against Pointer\'s inference port',
  'GET /api/apps/unified': 'the Apps page list in Settings, which standard users see',
  'GET /api/auth/session': 'the caller\'s own session',
  'GET /api/branding/profile-avatar-art/[id]': 'built-in avatar art',
  'GET /api/domain': 'the box\'s domain, for the Market pages',
  'GET /api/identity/consents/app/[appId]': 'the caller\'s own consent for an app',
  'DELETE /api/identity/consents/app/[appId]': 'revokes the caller\'s own consent for an app',
  'POST /api/identity/sign-out-everywhere': 'signs the caller out of their own sessions',
  'GET /api/market': 'catalog',
  'GET /api/market/app/[appId]': 'catalog entry',
  'GET /api/market/app/[appId]/connections': 'connections an app could make, for the install dialog',
  'GET /api/market/app/[appId]/provider-options': 'providers an app could use, for the install dialog',
  'GET /api/market/catalog': 'catalog',
  'GET /api/market/install-status': 'install progress',
  'GET /api/market/providers': 'installed providers',
  'GET /api/market/status': 'installed apps\' status',
  'GET /api/market/updates': 'available app updates',
  'GET /api/market/validate-subdomain': 'checks that a subdomain is free',
  'GET /api/pointer-ui/[...path]': 'Pointer\'s static UI assets (allowlisted paths)',
  'GET /api/telemetry/settings': 'whether local usage statistics are on, for the Privacy page',
  'GET /api/ui/branding': 'box branding for the signed-in surfaces',
  'GET /api/ui-settings/[...path]': 'proxies to the UI\'s settings API with the caller\'s role; the UI checks admin itself',
  'POST /api/ui-settings/[...path]': 'proxies to the UI\'s settings API with the caller\'s role; the UI checks admin itself',
  'PUT /api/ui-settings/[...path]': 'proxies to the UI\'s settings API with the caller\'s role; the UI checks admin itself',
  'PATCH /api/ui-settings/[...path]': 'proxies to the UI\'s settings API with the caller\'s role; the UI checks admin itself',
  'DELETE /api/ui-settings/[...path]': 'proxies to the UI\'s settings API with the caller\'s role; the UI checks admin itself',
  'POST /api/user/avatar': 'the caller\'s own avatar',
  'DELETE /api/user/avatar': 'the caller\'s own avatar',
  'POST /api/user/password': 'the caller\'s own password',
  'GET /api/user/profile': 'the caller\'s own profile',
  'PATCH /api/user/profile': 'the caller\'s own profile',
};

function publicRoutes(): { prefix: string[]; exact: string[] } {
  const source = readFileSync(path.join(root, 'proxy.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const list = (name: string) => {
    const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(match, name);
    return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  };
  // The proxy also passes every /embed path without a session (embeds show their own sign-in prompt).
  return { prefix: [...list('PUBLIC_ROUTES'), '/embed'], exact: list('PUBLIC_ROUTES_EXACT') };
}

function routeFiles(dir = path.join(root, 'app')): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === 'route.ts' ? [full] : [];
  });
}

function urlOf(file: string): string {
  const dir = path.relative(path.join(root, 'app'), path.dirname(file)).split(path.sep).join('/');
  return ('/' + dir).replace(/\/\([^)]*\)/g, '').replace(/\/$/, '') || '/';
}

function resolveImport(spec: string, from: string): string {
  const base = spec.startsWith('@/') ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

/** The text of every top-level function in a file, by name (declarations and const arrow functions). */
function localFunctions(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const starts = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm)];
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    found.set(match[1] ?? match[2], source.slice(match.index, end));
  });
  return found;
}

function checksAuth(file: string, handler: string, check: RegExp = AUTH_CALL, seen = new Set<string>()): boolean {
  const key = `${file}#${handler}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const item of match[1].split(',').map(part => part.trim()).filter(Boolean)) {
      const [original, alias] = item.split(/\s+as\s+/);
      if ((alias ?? original) === handler) return checksAuth(resolveImport(match[2], file), original, check, seen);
    }
  }
  const functions = localFunctions(source);
  const body = functions.get(handler);
  if (body === undefined) throw new Error(`${path.relative(root, file)}: no ${handler}`);
  const reaches = (text: string, visited: Set<string>): boolean => {
    if (check.test(text)) return true;
    for (const [name, delegateFile] of Object.entries(AUTH_DELEGATES)) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(text) && delegateChecks(delegateFile, check)) return true;
    }
    for (const [name, text2] of functions) {
      if (name === handler || visited.has(name) || !new RegExp(`\\b${name}\\s*\\(`).test(text)) continue;
      visited.add(name);
      if (reaches(text2, visited)) return true;
    }
    return false;
  };
  return reaches(body, new Set([handler]));
}

function delegateChecks(file: string, check: RegExp): boolean {
  return check.test(stripComments(readFileSync(path.join(root, file), 'utf8')));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function handlersOf(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  // Fail on export forms the walker can't judge, rather than skipping them.
  assert.doesNotMatch(source, /export\s*\*\s*from/, `${path.relative(root, file)}: export * is not allowed in a route`);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    assert.ok(!/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(match[1]), `${path.relative(root, file)}: export handlers directly`);
  }
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/g)) {
    names.add(match[1] ?? match[2]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const item of match[1].split(',').map(part => part.trim()).filter(Boolean)) {
      const name = item.split(/\s+as\s+/).pop()!;
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

test('every route handler checks for an admin itself, or is public or a standard user\'s with a reason', () => {
  const { prefix, exact } = publicRoutes();
  const isPublic = (url: string) => exact.includes(url) || prefix.some(route => url === route || url.startsWith(route + '/'));
  const unchecked: string[] = [];
  const used = new Set<string>();
  for (const file of routeFiles()) {
    const url = urlOf(file);
    for (const handler of handlersOf(file)) {
      const publicRoute = isPublic(url);
      if (checksAuth(file, handler, publicRoute ? AUTH_CALL : ADMIN_CALL)) continue;
      // Re-exported handlers (e.g. /settings/api/*) take their source's entry.
      const key = `${handler} ${url}`;
      const list = publicRoute ? PUBLIC_HANDLERS : STANDARD_USER_HANDLERS;
      const source = readFileSync(file, 'utf8');
      const reexport = source.match(/from\s*['"]@\/app(\/[^'"]*)\/route['"]/);
      const listedKey = reexport && !(key in list) ? `${handler} ${reexport[1].replace(/\/\([^)]*\)/g, '')}` : key;
      if (listedKey in list) used.add(listedKey);
      else unchecked.push(`${publicRoute ? 'public' : 'signed-in'} ${key}`);
    }
  }
  assert.deepEqual(unchecked, [], 'handlers without an (admin) check: add one, or list them with the reason');
  const stale = [...Object.keys(PUBLIC_HANDLERS), ...Object.keys(STANDARD_USER_HANDLERS)].filter(key => !used.has(key));
  assert.deepEqual(stale, [], 'listed handlers that no longer exist, or now check for an admin themselves');
});

test('a session check alone is not an admin check', () => {
  const sample = (body: string) => ADMIN_CALL.test(body);
  assert.equal(sample('const session = await getSession();\nif (!session) return NextResponse.json({}, { status: 401 });'), false);
  assert.equal(sample('const auth = await requireAuth(); if (auth.error) return auth.error;'), false);
  assert.equal(sample('return NextResponse.json({ isAdmin: session.isAdmin });'), false);
  assert.equal(sample('if (!session?.isAdmin) return NextResponse.json({}, { status: 403 });'), true);
  assert.equal(sample('if (!(await getSession())?.isAdmin) return forbidden;'), true);
  assert.equal(sample('const auth = await requireAdminCsrf(request);'), true);
});

test('the Control Panel has no SQL console and builds no psql shell string', () => {
  assert.equal(existsSync(path.join(root, 'app/api/apps/postgres')), false, 'the session-only SQL console is gone');
  assert.equal(existsSync(path.join(root, 'lib/postgres/client.ts')), false);
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    // psql runs with an argument list (or reads SQL from stdin); a -c '<sql>' inside a shell string is an injection.
    assert.doesNotMatch(source, /su - postgres -c "psql[^"]*-c/, path.relative(root, file));
  }
});

test('the proxy lets an X-CLI-Token request through only with the valid token', () => {
  const source = readFileSync(path.join(root, 'proxy.ts'), 'utf8');
  const block = source.slice(source.indexOf("request.headers.get('x-cli-token')"));
  assert.match(block.slice(0, 400), /if \(isValidCLIToken\(cliToken\)\) return applySecurityHeaders\(NextResponse\.next\(\)/);
  assert.match(block.slice(0, 500), /status: 401/);
  assert.doesNotMatch(source, /request\.headers\.get\('x-cli-token'\)\)\s*\{\s*return applySecurityHeaders/);
});

test('the orphans API needs an admin, and CSRF to clean up', () => {
  const source = readFileSync(path.join(root, 'app/api/admin/orphans/route.ts'), 'utf8');
  assert.match(source, /export async function GET\(\) \{\s*const auth = await requireAdmin\(\);\s*if \(auth\.error\) return auth\.error;/);
  assert.match(source, /export async function POST\(request: NextRequest\) \{\s*const auth = await requireAdminCsrf\(request\);\s*if \(auth\.error\) return auth\.error;/);
});

test('the proxy refuses a bogus X-CLI-Token and fails closed without a JWT secret', async () => {
  const { NextRequest } = await import('next/server');
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.JWT_SECRET;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    const { proxy } = await import('../src/proxy.ts?route-auth');
    const call = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`https://control.example.test${path}`, {
      headers: { host: 'control.example.test', ...headers },
    }));
    // No CLI token file exists here, so every presented token is bogus.
    for (const path of ['/api/admin/orphans', '/api/market/status', '/api/people']) {
      assert.equal((await call(path, { 'x-cli-token': 'bogus' })).status, 401, path);
      assert.equal((await call(path, { 'x-cli-token': '' })).status, 401, path);
    }
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    assert.equal((await call('/api/admin/orphans')).status, 401, 'no session');
    // Password sign-in is refused on named hosts through both paths (the Settings one re-exports the same handler).
    for (const path of ['/api/auth/login', '/settings/api/auth/login']) {
      const response = await proxy(new NextRequest(`https://control.example.test${path}`, { method: 'POST', headers: { host: 'control.example.test' } }));
      assert.equal(response.status, 403, path);
    }
    // Cookie-authenticated writes from another origin are refused before the handler runs.
    const write = (origin: string | null, extra: Record<string, string> = {}) => proxy(new NextRequest('https://control.example.test/api/settings', {
      method: 'PATCH',
      headers: { host: 'control.example.test', 'x-forwarded-proto': 'https', cookie: 'ye-session=forged', ...(origin ? { origin } : {}), ...extra },
    }));
    for (const origin of ['https://evil.example', 'https://app.example.test', 'http://control.example.test', 'null']) {
      assert.equal((await write(origin)).status, 403, origin);
    }
    assert.equal((await write(null, { 'sec-fetch-site': 'cross-site' })).status, 403);
    // Same origin (or no browser at all) reaches the session check, which refuses the forged cookie.
    assert.equal((await write('https://control.example.test')).status, 401);
    assert.equal((await write(null)).status, 401);
    delete process.env.JWT_SECRET;
    const closed = await call('/api/admin/orphans', { cookie: 'ye-session=anything' });
    assert.equal(closed.status, 503);
    assert.equal(closed.headers.get('x-middleware-next'), null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});

test('standard users read the Market; every Market change is an admin\'s', () => {
  // Owner, 2026-11-21: install, update, uninstall, sources (and version checks, which read every market) stay admin-only.
  const market = Object.keys(STANDARD_USER_HANDLERS).filter(key => / \/api\/(market|apps\/check-updates)\b/.test(key));
  // POST /api/market/validate is an admin's too: its image check makes the box reach any registry a manifest names.
  assert.deepEqual(market.filter(key => !key.startsWith('GET ')), []);
});
