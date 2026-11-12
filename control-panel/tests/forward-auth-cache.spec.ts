import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createPlatformDatabase } from '../src/lib/postgres/platform-transport';
import { checkForwardAuth, matchAdmissionRoute, type ForwardAuthDeps } from '../src/lib/identity/forward-auth';
import {
  TtlLruCache, clearForwardAuthCaches, createForwardAuthCaches, forwardAuthCaches,
} from '../src/lib/identity/forward-auth-cache';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const installationId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const policy = {
  schemaVersion: 1 as const, appId: 'mealie', installationId, ownerId: userId, mode: 'owner' as never,
  userIds: [], groupIds: [], revision: 3, state: 'ready' as never, publicAccess: false,
  createdAt: '', updatedAt: '',
};

/** Deps whose every lookup is one command on a single-connection transport with real latency. */
function fakeBox(latencyMs = 3) {
  const state = { revoked: new Set<string>(), commands: 0, failEvaluate: 0 };
  const database = createPlatformDatabase(async () => ({ host: 'h', port: '1', user: 'u', password: 'p', database: 'd' }), {
    driver: (() => ({
      unsafe: () => ({ simple: () => ({ raw: async () => {
        state.commands++;
        await new Promise(resolve => setTimeout(resolve, latencyMs));
        return Object.assign([[Buffer.from('ok')]], { columns: [] });
      } }) }),
      end: async () => undefined,
    })) as never,
  });
  const deps: ForwardAuthDeps = {
    hostRoutes: async host => { await database.command('routes'); return host === 'mealie.box.test'
      ? [{ pathPrefix: '/', policy }, { pathPrefix: '/api/hooks', policy }] : []; },
    machineCallbacks: async () => { await database.command('callbacks'); return [{ method: 'POST', path: '/logout/backchannel' }]; },
    publicAccessApplied: async () => { await database.command('public'); return true; },
    identify: async token => {
      await database.command('session');
      return token.startsWith('valid') && !state.revoked.has(token)
        ? { userId, headers: { 'X-YouEye-Uid': userId } } : null;
    },
    evaluate: async () => {
      await database.command('evaluate');
      if (state.failEvaluate > 0) { state.failEvaluate--; throw new Error('Platform database command failed'); }
      return { allowed: true, reason: 'allowed', installationId, revision: 3 } as never;
    },
  };
  return { state, deps };
}

const check = (deps: ForwardAuthDeps, caches: ReturnType<typeof createForwardAuthCaches>, extra: Partial<{
  path: string; method: string; sessionToken: string | null; host: string;
}> = {}) => checkForwardAuth({ host: 'mealie.box.test', path: '/', method: 'GET', sessionToken: 'valid-cookie', ...extra }, deps, caches);

test('200 concurrent forward-auth checks (one browser page load) all succeed with few queries', async () => {
  const { state, deps } = fakeBox(3);
  const caches = createForwardAuthCaches();
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) =>
    check(deps, caches, { path: `/_nuxt/chunk-${i}.js` })));
  for (const result of results) assert.deepEqual(result, { kind: 'allow', headers: { 'X-YouEye-Uid': userId } });
  assert.equal(state.commands, 4, 'routes, callbacks, session and admission are each loaded once');
});

test('a cached decision answers without any database query', async () => {
  const { state, deps } = fakeBox();
  const caches = createForwardAuthCaches();
  await check(deps, caches);
  const before = state.commands;
  assert.equal((await check(deps, caches, { path: '/_nuxt/other.js' })).kind, 'allow');
  assert.equal(state.commands, before);
});

test('a revoked session is refused after invalidation, and at the latest when the TTL expires', async () => {
  const { state, deps } = fakeBox();
  let now = 1_000;
  const caches = createForwardAuthCaches({ ttlMs: 10_000, now: () => now });
  assert.equal((await check(deps, caches)).kind, 'allow');
  state.revoked.add('valid-cookie');
  // Revoked in another process: the cached grant lasts at most the TTL.
  now += 9_000;
  assert.equal((await check(deps, caches)).kind, 'allow');
  now += 1_001;
  assert.equal((await check(deps, caches)).kind, 'login');

  // Revoked in this process: invalidation applies at once.
  state.revoked.clear();
  assert.equal((await check(deps, caches)).kind, 'allow');
  state.revoked.add('valid-cookie');
  for (const cache of Object.values(caches)) cache.clear();
  assert.equal((await check(deps, caches)).kind, 'login');
});

test('the process-wide caches are cleared by revocation and policy changes', async () => {
  const { state, deps } = fakeBox();
  assert.equal((await checkForwardAuth({ host: 'mealie.box.test', path: '/', method: 'GET', sessionToken: 'valid-x' }, deps)).kind, 'allow');
  state.revoked.add('valid-x');
  clearForwardAuthCaches();
  assert.equal((await checkForwardAuth({ host: 'mealie.box.test', path: '/', method: 'GET', sessionToken: 'valid-x' }, deps)).kind, 'login');
  assert.equal(forwardAuthCaches(), forwardAuthCaches());
  const identity = readFileSync(path.join(root, 'src/lib/identity/store.ts'), 'utf8');
  for (const fn of ['revokeIdentitySession', 'revokeAllIdentitySessions']) {
    const body = identity.slice(identity.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /clearForwardAuthCaches\(\)/, fn);
  }
  const admission = readFileSync(path.join(root, 'src/lib/admission/store.ts'), 'utf8');
  const update = admission.slice(admission.indexOf('async function updateAdmissionPolicyUnderLifecycle('));
  assert.match(update.slice(0, update.indexOf('\n}\n')), /clearForwardAuthCaches\(\)/);
});

test('errors and unverified sessions are never cached', async () => {
  const { state, deps } = fakeBox();
  const caches = createForwardAuthCaches();
  state.failEvaluate = 1;
  await assert.rejects(check(deps, caches), /Platform database command failed/);
  assert.equal((await check(deps, caches)).kind, 'allow');

  const before = state.commands;
  assert.equal((await check(deps, caches, { sessionToken: 'forged' })).kind, 'login');
  assert.equal((await check(deps, caches, { sessionToken: 'forged' })).kind, 'login');
  assert.equal(state.commands - before, 2, 'each unverified cookie is checked again');
  assert.equal((await check(deps, caches, { sessionToken: null })).kind, 'login');
});

test('machine callbacks, public apps and unknown routes keep their meaning', async () => {
  const { deps } = fakeBox();
  const caches = createForwardAuthCaches();
  assert.deepEqual(await check(deps, caches, { path: '/logout/backchannel', method: 'POST', sessionToken: null }), { kind: 'pass' });
  assert.equal((await check(deps, caches, { path: '/logout/backchannel', method: 'GET', sessionToken: null })).kind, 'login');
  assert.deepEqual(await check(deps, caches, { host: 'other.box.test' }), { kind: 'unknown_route' });
  assert.deepEqual(await check(deps, caches, { host: 'Bad_Host' }), { kind: 'unknown_route' });
  policy.publicAccess = true;
  try { assert.deepEqual(await check(deps, createForwardAuthCaches(), { sessionToken: null }), { kind: 'pass' }); }
  finally { policy.publicAccess = false; }
});

test('in-memory route matching follows the SQL rule', () => {
  const routes = [{ pathPrefix: '/' }, { pathPrefix: '/api' }, { pathPrefix: '/api/v2' }];
  assert.equal(matchAdmissionRoute(routes, '/api/v2/x')?.pathPrefix, '/api/v2');
  assert.equal(matchAdmissionRoute(routes, '/api')?.pathPrefix, '/api');
  assert.equal(matchAdmissionRoute(routes, '/apiary')?.pathPrefix, '/');
  assert.equal(matchAdmissionRoute([{ pathPrefix: '/app' }], '/other'), null);
});

test('the cache is a bounded LRU with TTL', async () => {
  let now = 0;
  const cache = new TtlLruCache<number>(3, 100, () => now);
  for (const key of ['a', 'b', 'c']) await cache.getOrLoad(key, async () => 1);
  await cache.getOrLoad('a', async () => 2); // refresh recency of a
  await cache.getOrLoad('d', async () => 1); // evicts b
  assert.equal(cache.size, 3);
  assert.equal(await cache.getOrLoad('a', async () => 9), 1);
  assert.equal(await cache.getOrLoad('b', async () => 9), 9);
  now = 200;
  assert.equal(await cache.getOrLoad('a', async () => 7), 7);
});
