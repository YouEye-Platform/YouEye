import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for UI runtime networking + schema init.
// Run: UI_ROOT="$PWD" pnpm exec node --test tests/runtime-network-and-schema.spec.mjs
const repoRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('instrumentation raises the happy-eyeballs attempt timeout at process start', () => {
  // Dual-stack hosts without a working IPv6 route: Node 22's 250 ms default
  // made every gateway upstream fetch die ETIMEDOUT before falling back to
  // IPv4 (Weather location search bug, validated live on clone .80).
  const instrumentation = read('src/instrumentation.ts');
  assert.match(instrumentation, /setDefaultAutoSelectFamilyAttemptTimeout\(2000\)/);
  // Must run before anything else can fetch — i.e. inside register(), gated
  // on the nodejs runtime.
  assert.match(instrumentation, /NEXT_RUNTIME === "nodejs"/);
});

test('ensureSchema is single-flight so concurrent first requests do not double-run DDL', () => {
  const db = read('src/db/index.ts');
  assert.match(db, /schemaInitInFlight/);
  assert.match(db, /if \(!schemaInitInFlight\)/);
  // A failed init must clear the memo so the next request retries.
  assert.match(db, /schemaInitInFlight = null/);
});

test('postgres client filters idempotent-DDL NOTICE spam but keeps real notices', () => {
  const db = read('src/db/index.ts');
  assert.match(db, /onnotice/);
  assert.match(db, /already exists, skipping/);
  // Non-matching notices must still be logged.
  assert.match(db, /\[db notice\]/);
});
