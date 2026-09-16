import assert from 'node:assert/strict';
import test from 'node:test';

import { componentUpdatePresentation } from '../src/lib/updates/presentation';

test('unpromoted repository release is not presented over the configured channel', () => {
  const result = componentUpdatePresentation({
    current: '0.5.22.0.1',
    latest: '0.5.22.0.2',
    available: true,
    candidate: { version: '0.5.22.0.1', branch: 'main', tag: 'cp-v0.5.22.0.1' },
    update_available: false,
  });

  assert.deepEqual(result, {
    available: false,
    current: '0.5.22.0.1',
    candidate: '0.5.22.0.1',
  });
});

test('legacy Spine response remains supported when no channel fields exist', () => {
  const result = componentUpdatePresentation({
    current: '0.5.22.0.1',
    latest: '0.5.22.0.2',
    available: true,
  });
  assert.equal(result.available, true);
  assert.equal(result.candidate, '0.5.22.0.2');
});
