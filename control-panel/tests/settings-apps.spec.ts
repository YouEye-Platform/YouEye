import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 — Apps list reconcile.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-apps.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

test('Installed-apps list restyled to a card with head + Open Market link', () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  assert.match(c, />Installed apps</);
  assert.match(c, />Open Market</);
  assert.match(c, /href="\/market"/);
  assert.match(c, /overflow-hidden rounded-xl border bg-card/);
});

test('rows show real subdomain + status (no fabricated version/surfaces — pitfall #28)', () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  // subdomain rendered as <sub>.<host>, host from window.location
  assert.match(c, /\$\{app\.subdomain\}\.\$\{host\}/);
  // "unknown" status is suppressed rather than shown as a fake "Running"
  assert.match(c, /app\.status !== "unknown"/);
  assert.match(c, />Manage</);
});

test('page header matches the mockup copy', () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  assert.match(c, /Apps installed on this server and how they behave for you/);
  // the redundant inner "Installed Apps" h3 is gone (folded into the card head)
  assert.doesNotMatch(c, />Installed Apps</);
});

test('no raw text inputs introduced on the list view', () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  // the confirm-dialog checkboxes are allowed; assert no text inputs were added to the list
  assert.doesNotMatch(c, /<input type="text"/);
});
