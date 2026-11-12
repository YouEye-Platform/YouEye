import assert from 'node:assert/strict';
import test from 'node:test';
import { nextSetupStepErrors, setupStepReason } from '../src/lib/setup/step-reason';

test('setup step reason keeps the first line, redacts credentials, and is bounded', () => {
  assert.equal(
    setupStepReason(new Error('Pointer release fetch failed: https://user:hunter2@git.example/Pointer\nstack line')),
    'Pointer release fetch failed: https://<redacted>@git.example/Pointer',
  );
  assert.equal(setupStepReason(new Error('bad token=abc123 and Bearer xyz.789')), 'bad token=<redacted> and Bearer <redacted>');
  assert.equal(setupStepReason(new Error('\n  \nYouEye AI service did not become ready\nmore')), 'YouEye AI service did not become ready');
  const long = setupStepReason(new Error('x'.repeat(500)));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  assert.equal(setupStepReason(new Error('')), 'unknown error');
  assert.equal(setupStepReason('plain string failure'), 'plain string failure');
});

test('setup step errors record a failed step reason and clear it on any other state', () => {
  const failed = nextSetupStepErrors({}, 'ai', 'error', 'YouEye AI service did not become ready');
  assert.deepEqual(failed, { ai: 'YouEye AI service did not become ready' });
  assert.deepEqual(nextSetupStepErrors({ ...failed, dns: 'x' }, 'ai', 'done'), { dns: 'x' });
  assert.equal(nextSetupStepErrors(failed!, 'ai', 'done'), null);
  assert.equal(nextSetupStepErrors(failed!, 'ai', 'error'), null, 'an unexplained failure drops the stale reason');
});
