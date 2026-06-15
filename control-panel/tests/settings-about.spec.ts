import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 — About page.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-about.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('About page renders the mockup cards: This server + Software', () => {
  const c = read('src/components/settings-shell/about-client.tsx');
  assert.match(c, /title="This server"/);
  assert.match(c, /title="Software"/);
  assert.match(c, /<PageHeader title="About"/);
});

test('About pulls real server identity, versions, channel, reachability', () => {
  const c = read('src/components/settings-shell/about-client.tsx');
  assert.match(c, /\/settings\/api\/settings"/);        // siteName + releaseBranch
  assert.match(c, /\/settings\/api\/settings\/system/);  // hostname / os / uptime
  assert.match(c, /\/api\/health\/services/);            // spine ("core") version
  assert.match(c, /\/api\/domain/);                      // domain
  assert.match(c, /\/api\/tls\/status/);                 // HTTPS state
  // "interface" version is the build-time CP version, injected by the page
  assert.match(c, /cpVersion/);
});

test('About degrades honestly — Promise.allSettled, logs failures, no fabricated values (pitfalls #23/#28)', () => {
  const c = read('src/components/settings-shell/about-client.tsx');
  assert.match(c, /Promise\.allSettled/);
  assert.match(c, /console\.error\("\[About\]/);
  // no empty catch swallow
  assert.doesNotMatch(c, /catch\s*\(\s*\)\s*\{\s*\}/);
});

test('telemetry export removed from About (moves to Privacy per D18)', () => {
  const c = read('src/components/settings-shell/about-client.tsx');
  assert.doesNotMatch(c, /\/api\/telemetry\/export/);
  assert.doesNotMatch(c, /Usage Report/);
});

test('About page injects CP version from package.json and is admin-gated', () => {
  const p = read('src/app/settings/(shell)/about/page.tsx');
  assert.match(p, /import pkg from/);
  assert.match(p, /cpVersion=\{pkg\.version\}/);
  assert.match(p, /session\?\.isAdmin/);
});

test('Open source licenses page exists, admin-gated, lists the platform license', () => {
  assert.ok(has('src/app/settings/(shell)/about/licenses/page.tsx'), 'licenses page must exist');
  const l = read('src/app/settings/(shell)/about/licenses/page.tsx');
  assert.match(l, /Business Source License 1\.1/);
  assert.match(l, /session\?\.isAdmin/);
  // linked from About
  const c = read('src/components/settings-shell/about-client.tsx');
  assert.match(c, /\/settings\/about\/licenses/);
});

test('No raw inputs or radix deps on the About surface', () => {
  const c = read('src/components/settings-shell/about-client.tsx');
  assert.doesNotMatch(c, /<input/);
  assert.doesNotMatch(c, /from ["']@radix-ui/);
});
