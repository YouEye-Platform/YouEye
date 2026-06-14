import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');
function read(path: string): string {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('E4: account menu is the Google-style panel (greeting, manage pill, footer)', () => {
  const src = read('src/components/layout/user-menu.tsx');
  assert.match(src, /Hi, \{firstName\}!/);
  assert.match(src, /Manage your account/);
  assert.match(src, /About this server/);
  assert.match(src, /size-\[76px\]/); // big avatar
  assert.match(src, /w-\[340px\]/); // wide panel
});

test('E4: theme is a Light/Dark/Auto segmented control, not a cycle button', () => {
  const src = read('src/components/layout/user-menu.tsx');
  assert.match(src, /aria-pressed=\{active\}/);
  assert.match(src, /applyTheme\(mode\)/);
  // the three modes are rendered together (segmented), and DB-synced for native apps
  assert.match(src, /mode: "light"[\s\S]*mode: "dark"[\s\S]*mode: "system"/);
  assert.match(src, /\/api\/v1\/themes\/active/);
  assert.doesNotMatch(src, /DropdownMenuItem/); // no longer the plain dropdown
});
