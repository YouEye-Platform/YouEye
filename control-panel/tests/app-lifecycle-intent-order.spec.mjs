import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('app lifecycle persists desired state before any stop-side Incus mutation', () => {
  const source = readFileSync(new URL('../src/lib/apps/lifecycle.ts', import.meta.url), 'utf8');
  const stop = source.slice(source.indexOf("if (action === 'stop')"), source.indexOf("if (action === 'start')"));
  const persist = stop.indexOf('await beginLifecycleOperation');
  const autostart = stop.indexOf('await setBootAutostart');
  const runtime = stop.indexOf('await changeContainerState');
  assert.ok(persist >= 0 && persist < autostart && autostart < runtime);
  assert.match(stop, /await finishLifecycleOperation\(meta, error\)/);
});
