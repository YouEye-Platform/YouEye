import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('UI telemetry is disabled by default and requires explicit opt-in', () => {
  const tracker = read('src/lib/telemetry/tracker.ts');
  const route = read('src/app/api/v1/telemetry/record/route.ts');
  assert.match(tracker, /TELEMETRY_ENABLED === "true"/);
  assert.match(tracker, /TELEMETRY_DISABLED !== "true"/);
  assert.match(tracker, /enabled: ENABLED/);
  assert.match(tracker, /trackRoute\(pathname: string\): void \{\s*if \(!ENABLED\) return;/);
  assert.match(tracker, /trackError\(route: string, message: string\): void \{\s*if \(!ENABLED\) return;/);
  assert.match(route, /if \(!isTelemetryEnabled\(\)\)/);
});
