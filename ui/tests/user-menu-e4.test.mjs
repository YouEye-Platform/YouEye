import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// Plan 1 E4 (D14-revised) — the UI account menu is toned down (less Google-like).
// Run: node --test tests/user-menu-e4.test.mjs
const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const menu = read('src/components/layout/user-menu.tsx');

test('the three Google-isms are removed: pill, pencil-edit, Privacy·About footer', () => {
  assert.doesNotMatch(menu, />\s*Manage your account/);     // no pill button (text node)
  assert.doesNotMatch(menu, /import \{[^}]*\bPencil\b/);     // Pencil no longer imported
  assert.doesNotMatch(menu, /<Pencil/);                     // no pencil badge
  assert.doesNotMatch(menu, />\s*About this server/);       // no footer button
  assert.doesNotMatch(menu, /settings\/privacy/);           // footer Privacy link gone
});

test('what stays: email, greeting, Timeline, Settings, Sign out', () => {
  assert.match(menu, /\{email\}/);
  assert.match(menu, /Hi, \{firstName\}!/);
  assert.match(menu, /t\("timeline"\)/);
  assert.match(menu, /t\("settings"\)/);
  assert.match(menu, /t\("signOut"\)/);
});

test('the Light/Dark/Auto segmented theme control is kept', () => {
  assert.match(menu, /THEMES/);
  assert.match(menu, /applyTheme\(mode\)/);
  assert.match(menu, /Sun, Moon, Monitor/);                 // the three mode icons
  assert.match(menu, /aria-pressed=\{active\}/);
});

test('the big avatar is display-only (not a button → no edit affordance)', () => {
  // the avatar block no longer wraps the Avatar in a button/onClick edit control
  assert.doesNotMatch(menu, /aria-label="Edit profile"/);
});
