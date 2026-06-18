import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('setup completion persists and reuses the selected TLS path', () => {
  const run = read('src/app/api/setup/run/route.ts');
  const setup = read('src/app/setup/page.tsx');
  const complete = read('src/app/setup-complete/page.tsx');
  const settings = read('src/lib/settings/service.ts');

  assert.match(run, /tls_choice: body\.tls_choice \|\| 'selfsigned'/);
  assert.match(setup, /router\.replace\(`\/setup-complete\?tls=\$\{encodeURIComponent\(tlsChoice\)\}`\)/);
  assert.match(complete, /new URLSearchParams\(window\.location\.search\)\.get\('tls'\)/);
  assert.match(complete, /data\.extra\?\.tls_choice/);
  assert.match(complete, /tlsChoice=\{tlsChoice\}/);
  assert.match(settings, /function flattenExtra/);
});

test('fallback favicon is the transparent blue Y used during initial setup', () => {
  const favicon = read('src/app/api/branding/favicon/route.ts');

  assert.match(favicon, /fill="#2563eb"/);
  assert.doesNotMatch(favicon, /fill="#111827"/);
  assert.doesNotMatch(favicon, /<rect[^>]+fill="#111827"/);
});

test('PAM login tree is the default full-screen root emergency door asset', () => {
  const login = read('src/components/auth/login-form.tsx');
  const art = read('src/components/auth/root-tree-art.ts');

  assert.match(login, /useState\('root'\)/);
  assert.match(login, /username\.trim\(\) === 'root'/);
  assert.match(login, /aria-hidden="true"/);
  assert.match(login, /Enter your root password/);
  assert.match(login, /Sign in with your Linux system credentials/);
  assert.match(login, /fixed inset-0/);
  assert.match(login, /bg-black text-amber-100/);
  assert.match(login, /ROOT_TREE_ART\.join\('\\n'\)/);
  assert.doesNotMatch(login, /from '@\/components\/ui\/card'/);
  assert.doesNotMatch(login, /Local administrator/);
  assert.doesNotMatch(login, /pamHint/);
  assert.doesNotMatch(login, /placeholder=/);
  assert.match(art, /Generated offline/);
  assert.doesNotMatch(art, /\x1b\[/);
  assert.doesNotMatch(art, /from 'github.com\/Zebbeni\/ansipx'/);
});
