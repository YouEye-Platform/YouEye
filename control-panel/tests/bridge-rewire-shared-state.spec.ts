/**
 * YE-224: Next bundles a module more than once per process (instrumentation and health code, each route). The
 * re-wiring's back-off, pass and start requests must be one state per process, so a user's start in a route bundle
 * reaches the pass another bundle runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('two copies of bridges/manager share the re-wire state (one per process)', async () => {
  const first = await import(new URL('../src/lib/bridges/manager.ts?bundle=route', import.meta.url).href);
  const second = await import(new URL('../src/lib/bridges/manager.ts?bundle=instrumentation', import.meta.url).href);
  assert.notEqual(first.requestRewire, second.requestRewire, 'two module instances, as in two Next bundles');
  const state = (globalThis as Record<symbol, any>)[Symbol.for('youeye.bridge-rewire')];
  assert.ok(state, 'the state lives on globalThis under Symbol.for("youeye.bridge-rewire")');
  // A failed re-wire left a back-off; a start in the route bundle clears it for the pass in the other bundle.
  state.backoff.set('sonarr-to-sabnzbd', { from: 'sonarr', to: 'sabnzbd', failures: 3, nextAt: Date.now() + 1_800_000 });
  first.requestRewire('sabnzbd');
  assert.equal(state.backoff.has('sonarr-to-sabnzbd'), false);
  assert.ok(state.requested.has('sabnzbd'));
  // The watch in the other bundle sees the request and starts the pass (no bridge store here: it ends with none).
  second.rewireWatchTick();
  assert.equal(state.requested.size, 0);
  assert.ok(state.pass, 'a pass is running');
  assert.equal(first.startRewirePass(), second.startRewirePass(), 'one pass per process, whichever bundle asks');
  await state.pass;
  // The watch is one timer per process too.
  first.startRewireWatch();
  const watch = state.watch;
  second.startRewireWatch();
  assert.equal(state.watch, watch);
  clearInterval(state.watch);
});
