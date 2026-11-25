import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyIgnore,
  applyObservation,
  applyResolution,
  findOpenCriticalIssue,
  INSTALL_GATE_IGNORED_ISSUES,
  issueAppId,
  type IssueStore,
} from '../src/lib/health/issues';

function emptyStore(): IssueStore {
  return { issues: {}, debounce: {} };
}

const input = {
  id: 'service:caddy',
  severity: 'critical' as const,
  source: 'service-monitor',
  title: 'Web access needs attention',
  body: 'The web gateway is not responding.',
  fixable: true,
  repairFn: 'restart-service:caddy',
};

test('debounces a new issue and preserves first/last seen plus count', () => {
  const store = emptyStore();
  assert.equal(applyObservation(store, input, '2026-07-19T01:00:00.000Z'), null);
  const opened = applyObservation(store, input, '2026-07-19T01:00:30.000Z');
  assert.equal(opened?.state, 'open');
  assert.equal(opened?.firstSeen, '2026-07-19T01:00:30.000Z');
  assert.equal(opened?.count, 1);

  const repeated = applyObservation(store, input, '2026-07-19T01:01:00.000Z');
  assert.equal(repeated?.firstSeen, opened?.firstSeen);
  assert.equal(repeated?.lastSeen, '2026-07-19T01:01:00.000Z');
  assert.equal(repeated?.count, 2);
});

test('ignore and resolve transitions remain explicit', () => {
  const store = emptyStore();
  applyObservation(store, { ...input, debounce: 1 }, '2026-07-19T01:00:00.000Z');
  const ignored = applyIgnore(store, input.id, 'Scheduled maintenance', '2026-07-19T01:01:00.000Z');
  assert.equal(ignored?.state, 'ignored');
  assert.equal(ignored?.ignoredReason, 'Scheduled maintenance');

  applyResolution(store, input.id, '2026-07-19T01:02:00.000Z');
  assert.equal(store.issues[input.id]?.state, 'resolved');
  assert.equal(store.issues[input.id]?.resolvedAt, '2026-07-19T01:02:00.000Z');
});

test('a resolved issue must pass debounce again before reopening', () => {
  const store = emptyStore();
  applyObservation(store, { ...input, debounce: 1 }, '2026-07-19T01:00:00.000Z');
  applyResolution(store, input.id, '2026-07-19T01:01:00.000Z');
  assert.equal(applyObservation(store, input, '2026-07-19T01:02:00.000Z'), null);
  assert.equal(applyObservation(store, input, '2026-07-19T01:02:30.000Z')?.state, 'open');
});

test('only an open critical issue activates the destructive-operation gate', () => {
  const store = emptyStore();
  applyObservation(store, { ...input, debounce: 1 }, '2026-07-19T01:00:00.000Z');
  assert.equal(findOpenCriticalIssue(Object.values(store.issues))?.id, input.id);

  applyIgnore(store, input.id, 'Known maintenance', '2026-07-19T01:01:00.000Z');
  assert.equal(findOpenCriticalIssue(Object.values(store.issues)), null);
});

test('an app\'s own critical issues gate only that app; box issues gate every install', () => {
  for (const [id, app] of [
    ['market.app-network.bazarr', 'bazarr'], ['market.install.rollback.memos', 'memos'],
    ['app.gramps-web.update-recovery', 'gramps-web'], ['app.bazarr.install-record', 'bazarr'],
    ['market.install-operation.state', null], ['market.update-journal.damaged', null], ['service:caddy', null],
  ] as const) assert.equal(issueAppId(id), app, id);
  const store = emptyStore();
  applyObservation(store, { ...input, id: 'app.bazarr.install-record', debounce: 1 }, '2026-11-18T08:40:00.000Z');
  const issues = Object.values(store.issues);
  assert.equal(findOpenCriticalIssue(issues, 'memos'), null);
  assert.equal(findOpenCriticalIssue(issues, 'bazarr')?.id, 'app.bazarr.install-record');
});

test('YouEye AI being down does not refuse an app install; any other critical box issue still does (YE-219)', () => {
  const store = emptyStore();
  // What the health monitor raises while Pointer is still starting after a fresh install's first boot.
  applyObservation(store, { ...input, id: 'service.pointer.down', title: 'YouEye AI is down', debounce: 1 },
    '2026-11-24T16:40:00.000Z');
  let issues = Object.values(store.issues);
  assert.deepEqual([...INSTALL_GATE_IGNORED_ISSUES], ['service.pointer.down']);
  assert.equal(findOpenCriticalIssue(issues, 'sonarr', INSTALL_GATE_IGNORED_ISSUES), null, 'the install goes ahead');
  // It stays a critical issue: Health shows it, and system and pool operations still wait for it.
  assert.equal(findOpenCriticalIssue(issues)?.id, 'service.pointer.down');
  // A real box-level fault still blocks the install, next to the Pointer one.
  applyObservation(store, { ...input, id: 'service.postgres.down', title: 'PostgreSQL is down', debounce: 1 },
    '2026-11-24T16:41:00.000Z');
  issues = Object.values(store.issues);
  assert.equal(findOpenCriticalIssue(issues, 'sonarr', INSTALL_GATE_IGNORED_ISSUES)?.id, 'service.postgres.down');
});
