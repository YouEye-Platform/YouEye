// Run: node --test tests/setup-stale-session.spec.mjs
// After a box reset at the same address, an old setup cookie must send the
// browser back to claim/sign-in, never report "another browser is applying setup".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { followSetupProgress, SetupProgressError } from '../src/lib/setup/progress.mjs';

function requireSetupSession(state) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/lib/setup/session.ts', import.meta.url), 'utf8'))
    .replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  return runInNewContext(`${source}\nrequireSetupSession`, {
    NextResponse: { json: (body, init) => Response.json(body, init) },
    getSession: async () => state.session,
    verifyCSRFToken: async (token) => token === 'csrf-ok',
    setupOwnerIsCurrent: async (owner) => { state.ownerChecks.push(owner); return owner === state.currentOwner; },
    clearSessionCookies: async () => { state.cleared++; },
  });
}

const setupSession = { isAdmin: true, authMethod: 'setup', setupOwnerId: 'owner-before-reset', setupSessionId: 's1' };
const request = (csrf = 'csrf-ok') => new Request('http://192.168.1.50/api/setup/run', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });

test('a setup session whose owner is no longer this box’s owner is cleared and sent to sign in', async () => {
  const state = { session: setupSession, currentOwner: 'owner-after-reset', ownerChecks: [], cleared: 0 };
  const result = await requireSetupSession(state)(request());
  assert.equal(result.session, undefined);
  assert.equal(result.response.status, 401);
  const body = await result.response.json();
  assert.equal(body.code, 'setup_sign_in_required');
  assert.doesNotMatch(body.error, /Another browser/);
  assert.equal(state.cleared, 1);
  assert.deepEqual(state.ownerChecks, ['owner-before-reset']);
});

test('the current owner’s setup session passes; missing sessions and bad CSRF do not', async () => {
  const state = { session: setupSession, currentOwner: 'owner-before-reset', ownerChecks: [], cleared: 0 };
  assert.equal((await requireSetupSession(state)(request())).session, setupSession);
  assert.equal((await requireSetupSession(state)(request('forged'))).response.status, 403);
  assert.equal((await requireSetupSession({ ...state, session: null })(request())).response.status, 401);
  assert.equal((await requireSetupSession({ ...state, session: { ...setupSession, authMethod: 'sso' } })(request())).response.status, 401);
  // Reads skip CSRF but still prove the owner.
  assert.equal((await requireSetupSession({ ...state, currentOwner: 'other' })(new Request('http://x/'), { csrf: false })).response.status, 401);
  assert.equal(state.cleared, 0);
});

test('the wizard treats a 401 from setup as "claim or sign in again"', async () => {
  const options = { messages: { failed: 'Setup needs attention', unknown: 'Check setup status' }, fetchStatus: async () => assert.fail('no status read') };
  await assert.rejects(
    followSetupProgress(async () => Response.json({ error: 'This setup sign-in is from before the server was reset. Sign in again.', code: 'setup_sign_in_required' }, { status: 401 }), options),
    (error) => error instanceof SetupProgressError && error.signIn === true,
  );
  await assert.rejects(
    followSetupProgress(async () => new Response('Another browser is currently applying setup changes.', { status: 409 }), options),
    (error) => error instanceof SetupProgressError && error.signIn === false,
  );
  const page = readFileSync(new URL('../src/app/setup/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /error instanceof SetupProgressError && error\.signIn\) \{ window\.location\.assign\('\/login'\)/);
  const run = readFileSync(new URL('../src/app/api/setup/run/route.ts', import.meta.url), 'utf8');
  assert.ok(run.indexOf('await requireSetupSession(request)') < run.indexOf('await acquireSetupOperation('));
  const start = readFileSync(new URL('../src/app/api/setup/names/start/route.ts', import.meta.url), 'utf8');
  assert.match(start, /await requireSetupSession\(request\)/);
});
