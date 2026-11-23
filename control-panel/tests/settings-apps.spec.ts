import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 — Apps list reconcile.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-apps.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => englishInterfaceSource(readFileSync(join(repoRoot, p), 'utf8'));

test('Installed apps: one grouped list with the Open Market link', () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  assert.match(c, /title="Installed apps"/);
  assert.match(c, /href="\/market"/);
  assert.match(c, /<ul className="settings-group">/);
});

test("each row opens the app's own page and shows a status only when the app is off (pitfall #28)", () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  assert.match(c, /href=\{`\/settings\/apps\/\$\{encodeURIComponent\(app\.id\)\}`\}/);
  // No fabricated status: "unknown"/"running" are not rendered as a fake "Running" label.
  assert.match(c, /\{app\.status === "stopped" && /);
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
