import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_RESTART_HELD_ISSUE, syncControlRestartHeldIssue } from '../src/lib/health/control-restart-held';
import { applyObservation, applyResolution, type IssueStore } from '../src/lib/health/issues';

function fixture() {
  const store: IssueStore = { issues: {}, debounce: {} };
  const issues = {
    observeIssue: async (input: Parameters<typeof applyObservation>[1]) => applyObservation(store, input, new Date().toISOString()),
    resolveIssue: async (id: string) => applyResolution(store, id, new Date().toISOString()),
  };
  return { store, issues };
}

test('a Control Panel restart that waits under a backup or restore past its longest wait is an issue the owner sees', async () => {
  const { store, issues } = fixture();
  // Nothing waits, and a restart that waits within its longest wait: no issue.
  await syncControlRestartHeldIssue(async () => ({ waiting: false }), issues);
  await syncControlRestartHeldIssue(async () => ({ waiting: true, waiting_since: '2026-11-21T00:00:00Z' }), issues);
  assert.equal(store.issues[CONTROL_RESTART_HELD_ISSUE], undefined);

  const held = { waiting: true, waiting_since: '2026-11-21T00:00:00Z', backup_held_since: '2026-11-21T06:00:00Z' };
  await syncControlRestartHeldIssue(async () => held, issues);
  const issue = store.issues[CONTROL_RESTART_HELD_ISSUE];
  assert.equal(issue?.state, 'open');
  // A warning: a critical issue would refuse installs and updates.
  assert.equal(issue?.severity, 'warning');
  assert.match(issue?.body ?? '', /backup or restore/);
  assert.match(issue?.body ?? '', /restart the box/);

  // Spine does not answer, or is older than the route's GET: no evidence, nothing changes.
  await syncControlRestartHeldIssue(async () => { throw new Error('405 method not allowed'); }, issues);
  await syncControlRestartHeldIssue(async () => ({ status: 'scheduled' }) as never, issues);
  assert.equal(store.issues[CONTROL_RESTART_HELD_ISSUE]?.state, 'open');

  // The backup has ended (the restart still waits for other work), or the restart was made: resolved.
  await syncControlRestartHeldIssue(async () => ({ waiting: true, waiting_since: held.waiting_since }), issues);
  assert.equal(store.issues[CONTROL_RESTART_HELD_ISSUE]?.state, 'resolved');
  await syncControlRestartHeldIssue(async () => held, issues);
  assert.equal(store.issues[CONTROL_RESTART_HELD_ISSUE]?.state, 'open');
  await syncControlRestartHeldIssue(async () => ({ waiting: false }), issues);
  assert.equal(store.issues[CONTROL_RESTART_HELD_ISSUE]?.state, 'resolved');
});
