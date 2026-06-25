import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDark, THEME_STORAGE_KEY, THEME_MODE_EVENT } from '../src/lib/theme';

// Source-regression checks for the CP Settings dark-mode fix (Plan 1, folded
// into Workstream C). The user's mode preference is owned by the UI DB and
// delivered via the CP→UI bridge; CP must APPLY it on load + persist a change.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-dark-mode.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('theme util: shared storage key + event + resolveDark logic', () => {
  // Must read the SAME localStorage key the dashboard's next-themes writes.
  assert.equal(THEME_STORAGE_KEY, 'theme');
  assert.equal(THEME_MODE_EVENT, 'youeye-theme-mode');
  assert.equal(resolveDark('dark', false), true);
  assert.equal(resolveDark('light', true), false);
  assert.equal(resolveDark('system', true), true);
  assert.equal(resolveDark('system', false), false);
});

test('layout: applies saved mode before first paint (no flash) and uses token bg', () => {
  const layout = read('src/app/layout.tsx');
  // <html> opts out of hydration warnings for the class the boot script adds.
  assert.match(layout, /suppressHydrationWarning/);
  // Pre-paint inline boot script reads the shared localStorage("theme") key.
  assert.match(layout, /dangerouslySetInnerHTML/);
  assert.match(layout, /localStorage\.getItem\('theme'\)/);
  assert.match(layout, /classList\.add\('dark'\)/);
  // The hardcoded light bg is gone so dark mode actually shows dark surfaces.
  assert.match(layout, /bg-background/);
  assert.doesNotMatch(layout, /bg-gray-50/);
});

test('control-header: applies the saved mode on load (not only on click)', () => {
  const header = read('src/components/control-surface/control-header.tsx');
  assert.match(header, /from "@\/lib\/theme"/);
  // An effect applies the mode whenever it (or the system pref) changes — i.e. on load.
  assert.match(header, /applyThemeMode\(themeMode as ThemeMode\)/);
  assert.match(header, /\}, \[themeMode, systemPref\]\)/);
  // Syncs when the Appearance page broadcasts a change.
  assert.match(header, /addEventListener\(THEME_MODE_EVENT/);
  // The cycle button now routes through the shared applier (no ad-hoc toggle left).
  assert.match(header, /applyThemeMode\(next as ThemeMode\)/);
  assert.doesNotMatch(header, /classList\.toggle\("dark"/);
});

test('appearance: Mode selector applies immediately + persists', () => {
  const appearance = read('src/components/settings-shell/appearance-client.tsx');
  assert.match(appearance, /from "@\/lib\/theme"/);
  // selectMode applies the class on click and tells the header, then PUTs to persist.
  assert.match(appearance, /applyThemeMode\(nextMode as ThemeMode\)/);
  assert.match(appearance, /broadcastThemeMode\(nextMode as ThemeMode\)/);
  assert.match(appearance, /uiSettingsApi\("themes\/active"\)/);
});
