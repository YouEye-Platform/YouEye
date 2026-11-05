import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceProbeFailure, initialProbeState, resetProbeBackoff, shouldSuppressAppRecovery } from '../src/lib/market/app-prober';

test('durable stopped intent suppresses recovery before runtime observation', () => {
  assert.equal(shouldSuppressAppRecovery({ enabled: false, desiredState: 'stopped' }), true);
  assert.equal(shouldSuppressAppRecovery({
    enabled: false,
    desiredState: 'stopped',
    lifecycleOperation: {
      id: 'stop-attempt',
      action: 'stop',
      desiredState: 'stopped',
      state: 'partial',
      actor: 'admin',
      startedAt: '2026-08-13T00:00:00Z',
      updatedAt: '2026-08-13T00:00:01Z',
      containers: [],
    },
  }), true);
  assert.equal(shouldSuppressAppRecovery({ enabled: true, desiredState: 'running' }), false);
});

test('start period suppresses failure counting and restart', () => {
  const decision = advanceProbeFailure(
    initialProbeState(),
    { threshold: 3, autoRestart: true, startPeriodMs: 60_000 },
    50_000,
    10_000,
  );
  assert.equal(decision.inStartPeriod, true);
  assert.equal(decision.state.failures, 0);
  assert.equal(decision.shouldRestart, false);
});

test('three failures trigger restart and exponential backoff', () => {
  let state = initialProbeState();
  for (const now of [20_000, 30_000]) {
    const decision = advanceProbeFailure(state, { threshold: 3, autoRestart: true, startPeriodMs: 0 }, now, 0);
    state = decision.state;
    assert.equal(decision.shouldRestart, false);
  }
  const third = advanceProbeFailure(state, { threshold: 3, autoRestart: true, startPeriodMs: 0 }, 40_000, 0);
  assert.equal(third.shouldRestart, true);
  assert.equal(third.state.backoffMs, 20_000);
  assert.equal(third.resultState, 'starting');
});

test('opt-out reports unhealthy without restarting', () => {
  const current = { ...initialProbeState(), failures: 2 };
  const decision = advanceProbeFailure(current, { threshold: 3, autoRestart: false, startPeriodMs: 0 }, 40_000, 0);
  assert.equal(decision.resultState, 'unhealthy');
  assert.equal(decision.shouldRestart, false);
});

test('two capped cycles stop automatic restarts as crash-looping', () => {
  const first = advanceProbeFailure(
    { ...initialProbeState(), failures: 3, backoffMs: 300_000, capCycles: 0 },
    { threshold: 3, autoRestart: true, startPeriodMs: 0 },
    400_000,
    0,
  );
  assert.equal(first.shouldRestart, true);
  assert.equal(first.state.capCycles, 1);
  const second = advanceProbeFailure(first.state, { threshold: 3, autoRestart: true, startPeriodMs: 0 }, 700_000, 0);
  assert.equal(second.shouldRestart, false);
  assert.equal(second.resultState, 'crash-looping');
});

test('ten healthy minutes reset restart backoff', () => {
  const healthySince = 1_000;
  const state = { ...initialProbeState(), backoffMs: 300_000, capCycles: 1, healthySince };
  assert.equal(resetProbeBackoff(state, healthySince + 599_999), state);
  const reset = resetProbeBackoff(state, healthySince + 600_000);
  assert.equal(reset.backoffMs, 10_000);
  assert.equal(reset.capCycles, 0);
});
