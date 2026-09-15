import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  applyIgnore,
  applyObservation,
  applyResolution,
  findOpenCriticalIssue,
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

test('registry SQL is passed directly to psql without a shell or unavailable user switcher', () => {
  const source = readFileSync(new URL('../src/lib/health/issue-store.ts', import.meta.url), 'utf8');
  assert.match(source, /execCommand/);
  assert.doesNotMatch(source, /execShell|runuser/);
  assert.match(source, /\['\/usr\/local\/bin\/psql', '-v', 'ON_ERROR_STOP=1'/);
});
