import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { followSetupProgress, readSetupProgress, setupProgressStatus, SetupProgressError } from '../src/lib/setup/progress.mjs';

const messages = { failed: 'Setup needs attention', unknown: 'Check setup status' };
const complete = { state: 'complete', steps: { finalize: 'done' } };
function progressResponse(events, disconnect = false) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      } else if (disconnect) controller.error(new TypeError('network error'));
      else controller.close();
    },
  }));
}
function fixture(statuses) {
  const state = { posts: 0, reads: 0, clock: 0, events: [], checking: [] };
  const options = {
    messages, timeoutMs: 4, pollMs: 1, now: () => state.clock,
    wait: async ms => { state.clock += ms; },
    onEvent: event => state.events.push(event),
    onChecking: checking => state.checking.push(checking),
    fetchStatus: async (url, init) => {
      assert.equal(url, '/api/setup/status');
      assert.ok(!init.method || init.method === 'GET');
      assert.equal(init.cache, 'no-store');
      const value = statuses[Math.min(state.reads++, statuses.length - 1)];
      if (value instanceof Error) throw value;
      return value instanceof Response ? value : Response.json(value);
    },
  };
  return { state, options, submit: response => async () => { state.posts++; return response; } };
}

test('a disconnected stream reads completed retained work without another setup POST', async () => {
  const f = fixture([complete]);
  await followSetupProgress(f.submit(progressResponse([{ step: 'config', status: 'done' }, { step: 'caddy', status: 'running' }], true)), f.options);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.state.checking, [true, false]);
  assert.ok(f.state.events.some(event => event.step === 'finalize' && event.status === 'done'));
});

test('reconnection follows in-progress and temporarily unavailable work to completion', async () => {
  const f = fixture([new Error('restart'), { state: 'pending', steps: { config: 'done', caddy: 'done' } }, complete]);
  await followSetupProgress(f.submit(progressResponse([], true)), f.options);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.reads, 3);
});

test('config completion cannot hide unfinished or failed native finalization', async () => {
  assert.equal(setupProgressStatus({ setup_completed: true }, { setupCompleted: false }, false).state, 'pending');
  assert.equal(setupProgressStatus({ setup_completed: true }, { setupCompleted: true }, true).state, 'pending');
  assert.equal(setupProgressStatus({ setup_completed: true, setup_steps: { finalize: 'error' } }, { setupCompleted: true }, false).state, 'error');
  assert.equal(setupProgressStatus({ setup_completed: true, setup_steps: { dns: 'pending' } }, { setupCompleted: true }, false).state, 'pending');
  assert.equal(setupProgressStatus({ setup_completed: true, setup_steps: { finalize: 'done' } }, { setupCompleted: true }, false).state, 'complete');
  const f = fixture([setupProgressStatus({ setup_completed: true }, { setupCompleted: true }, true)]);
  await assert.rejects(followSetupProgress(f.submit(progressResponse([], true)), f.options), error => error instanceof SetupProgressError && error.readOnly);
  assert.equal(f.state.posts, 1);
});

test('explicit server and step errors survive a later disconnect and never become success', async () => {
  for (const event of [{ error: 'DNS provisioning failed' }, { step: 'dns', status: 'error', message: 'DNS provisioning failed' }]) {
    const f = fixture([complete]);
    await assert.rejects(followSetupProgress(f.submit(progressResponse([event], true)), f.options), error => error.message === 'DNS provisioning failed' && !error.readOnly);
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.reads, 0);
  }
  const f = fixture([{ state: 'error', steps: { dns: 'error' } }]);
  await assert.rejects(followSetupProgress(f.submit(progressResponse([], true)), f.options), error => error.message === messages.failed && !error.readOnly);
});

test('an uncertain timeout offers status-only retry and does not submit setup twice', async () => {
  const statuses = [{ state: 'pending', steps: {} }];
  const f = fixture(statuses);
  await assert.rejects(followSetupProgress(f.submit(progressResponse([], true)), f.options), error => error.readOnly && error.message === messages.unknown);
  statuses.push(complete);
  await readSetupProgress(f.options);
  assert.equal(f.state.posts, 1);
});

test('early stream end and lost response headers reconcile, while explicit completion needs no readback', async () => {
  const f = fixture([complete]);
  await followSetupProgress(f.submit(progressResponse([])), f.options);
  await followSetupProgress(async () => { f.state.posts++; throw new TypeError('network error'); }, f.options);
  assert.equal(f.state.posts, 2);
  assert.equal(f.state.reads, 2);
  const done = fixture([]);
  await followSetupProgress(done.submit(progressResponse([{ complete: true, hasErrors: false }])), done.options);
  assert.equal(done.state.posts, 1);
  assert.equal(done.state.reads, 0);
});

test('server refusal, authentication loss and malformed status are never completion evidence', async () => {
  const f = fixture([complete]);
  await assert.rejects(followSetupProgress(f.submit(Response.json({ error: 'Setup is blocked' }, { status: 409 })), f.options), /Setup is blocked/);
  assert.equal(f.state.reads, 0);
  const denied = fixture([new Response('', { status: 401 })]);
  await assert.rejects(readSetupProgress(denied.options), error => error.readOnly);
  assert.equal(denied.state.reads, 1);
  const malformed = fixture([{ state: 'complete', steps: { dns: 'unexpected' } }]);
  await assert.rejects(readSetupProgress(malformed.options), error => error.readOnly);
  assert.throws(() => setupProgressStatus({ setup_completed: true, setup_steps: { dns: 'unknown' } }, { setupCompleted: true }, false));
});

function statusRoute(state) {
  // This route has no TypeScript-only syntax; exercise its actual GET with the
  // same retained setup session, isolated readers and the real status derivation.
  const source = readFileSync(new URL('../src/app/api/setup/status/route.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export const dynamic.*;\n/gm, '').replace('export async function GET', 'async function GET');
  let reads = 0;
  const get = runInNewContext(`${source}\nGET`, {
    NextResponse: Response, setupProgressStatus,
    getSession: async () => state.session,
    settingsService: { getRaw: async () => { reads++; return state.config; } },
    getApplianceClaimStatus: async () => state.claim,
    hasRetainedSetupOperation: () => { if (state.damaged) throw new Error('Unsafe marker'); return state.retained; },
  });
  return { get, reads: () => reads };
}

test('the retained setup session reads settled status after claim completion without another handshake', async () => {
  const state = { session: { isAdmin: true, authMethod: 'setup' }, config: { setup_completed: true, setup_steps: { finalize: 'done' } }, claim: { setupCompleted: true }, retained: false };
  const route = statusRoute(state);
  const response = await route.get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).state, 'complete');
  state.retained = true;
  assert.equal((await (await route.get()).json()).state, 'pending');
  state.damaged = true;
  assert.equal((await route.get()).status, 503);
});

test('status reads require the existing administrator session and do not read or change state otherwise', async () => {
  for (const session of [null, { isAdmin: false }]) {
    const route = statusRoute({ session });
    assert.equal((await route.get()).status, 401);
    assert.equal(route.reads(), 0);
  }
});

test('a UI callback cannot turn an explicit backend error into successful reconciliation', async () => {
  const f = fixture([complete]);
  f.options.onEvent = () => { throw new Error('view detached'); };
  await assert.rejects(followSetupProgress(f.submit(progressResponse([{ error: 'Native finalization failed' }], true)), f.options), /Native finalization failed/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.reads, 0);
});

test('post-completion readiness failure retries only the existing handoff, never setup', async () => {
  // Exercise the actual page callbacks without mounting unrelated wizard steps.
  const source = readFileSync(new URL('../src/app/setup/page.tsx', import.meta.url), 'utf8');
  const completeCallback = source.split('const handleProvisioningComplete = useCallback(() => {')[1].split('}, [tlsChoice,')[0];
  const retryCallback = source.split('onRetry={() => {')[1].split('}}')[0];
  const state = { error: '', statusOnly: false, restarting: false, posts: 0, reads: 0, readyCalls: 0 };
  const context = {
    tlsChoice: 'youeye-names', setupComplete: true, setupStatusOnlyRetry: false,
    SETUP_COMPLETE_PATH: '/setup-complete',
    setSetupError: value => { state.error = value; },
    setSetupRestarting: value => { state.restarting = value; },
    setSetupStatusOnlyRetry: value => { state.statusOnly = value; },
    interfaceTranslationRef: { current: () => 'Readiness unknown' },
    waitForControlPanelReady: async () => { state.readyCalls++; throw new Error('Readiness unknown'); },
    router: { replace() { assert.fail('unavailable Control Panel must not advance'); } },
    goToStep() { assert.fail('must preserve the selected TLS handoff'); },
    handleCheckSetupStatus() { state.reads++; },
    handleRunSetup() { state.posts++; },
  };
  context.handleProvisioningComplete = runInNewContext(`() => {${completeCallback}}`, context);
  context.handleProvisioningComplete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.error, 'Readiness unknown');
  assert.equal(state.statusOnly, true);
  runInNewContext(`() => {${retryCallback}}`, context)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.readyCalls, 2);
  assert.equal(state.posts, 0);
  assert.equal(state.reads, 0);
});
