import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');
function read(path: string): string {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('C1: Settings nav adds Privacy (Personal) + Backups (Admin)', () => {
  const shell = read('src/components/settings/settings-shell.tsx');
  assert.match(shell, /id: "privacy"[\s\S]*href: "\/settings\/privacy"/);
  assert.match(shell, /id: "backup"[\s\S]*href: "\/settings\/backup"/);
});

test('C1: Market removed from Settings nav (D9 — Market is a launcher app)', () => {
  const shell = read('src/components/settings/settings-shell.tsx');
  assert.doesNotMatch(shell, /id: "market"/);
  assert.doesNotMatch(shell, /href: "\/market"/);
  // Store icon was only used by the market entry — its import is gone too.
  assert.doesNotMatch(shell, /\bStore,/);
});
