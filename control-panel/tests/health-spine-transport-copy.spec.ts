import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceFailureCopy } from '../src/lib/health/monitor';

test('Control Panel socket failure does not claim the host Spine service is down', () => {
  const copy = serviceFailureCopy({ slug: 'spine', name: 'Spine' }, 'running', 'error');
  assert.match(copy.title, /cannot reach Spine/);
  assert.match(copy.body, /does not prove/);
  assert.doesNotMatch(`${copy.title} ${copy.body} ${copy.notification}`, /Spine is down/);
});

test('container service failure retains direct outage wording', () => {
  const copy = serviceFailureCopy({ slug: 'caddy', name: 'Caddy' }, 'running', 'stopped');
  assert.equal(copy.title, 'Caddy is down');
});
