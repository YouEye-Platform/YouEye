import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.UI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('navbar exposes the Wave 2 mobile bottom shell', () => {
  const navbar = read('src/components/layout/navbar.tsx');
  const sheet = read('src/components/layout/mobile-account-sheet.tsx');
  const css = read('src/app/globals.css');

  assert.match(navbar, /ye-mobile-shell-only/);
  assert.match(navbar, /<MobileAccountSheet/);
  assert.match(sheet, /<NotificationBell embedded/);
  assert.match(sheet, /<AppDrawer embedded/);
  assert.match(sheet, /<Launcher embedded/);
  assert.match(css, /display-mode: standalone/);
});
