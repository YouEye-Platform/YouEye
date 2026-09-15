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
  const provisioning = read('src/components/setup/SetupProvisioning.tsx');
  const complete = read('src/app/setup-complete/page.tsx');
  const settings = read('src/lib/settings/service.ts');

  assert.match(run, /tls_choice: body\.tls_choice \|\| 'selfsigned'/);
  assert.match(setup, /const SETUP_COMPLETE_PATH = '\/setup-complete'/);
  assert.match(setup, /\/api\/ping\?setup-complete-ready=/);
  assert.match(setup, /router\.replace\(SETUP_COMPLETE_PATH\)/);
  assert.match(setup, /isRestarting=\{setupRestarting\}/);
  assert.doesNotMatch(setup, /\/setup-complete\?tls=/);
  assert.match(setup, /let streamHasError = false/);
  assert.match(setup, /event\.complete === true/);
  assert.match(setup, /event\.hasErrors \|\| streamHasError/);
  assert.doesNotMatch(setup, /data === '\[DONE\]'\) \{\s*setSetupComplete\(true\)/);
  assert.match(run, /if \(hasError\) \{/);
  assert.match(run, /Setup needs attention before finishing/);
  assert.match(run, /complete: false, hasErrors: true/);
  assert.match(run, /controller\.close\(\)/);
  assert.match(provisioning, /isRestarting \= false/);
  assert.match(provisioning, /restartingServerInterface/);
  assert.match(complete, /new URLSearchParams\(window\.location\.search\)\.get\('tls'\)/);
  assert.match(complete, /data\.extra\?\.tls_choice/);
  assert.match(complete, /value === 'byo-provider'/);
  assert.match(complete, /tlsChoice=\{tlsChoice\}/);
  assert.match(settings, /function flattenExtra/);
});

test('setup defers the Control Panel restart until the durable transaction is complete', () => {
  const run = read('src/app/api/setup/run/route.ts');
  const clients = read('src/lib/identity/core-clients.ts');
  const spine = read('src/lib/spine/client.ts');

  assert.match(clients, /setControlSSO\([\s\S]*\}, false\)/);
  assert.match(spine, /control\/sso\?restart=\$\{restartControl\}/);
  assert.match(run, /markApplianceSetupComplete\([\s\S]*restartControl\(5\)[\s\S]*complete: true/);
});

test('fallback favicon is the transparent blue Y used during initial setup', () => {
  const favicon = read('src/app/api/branding/favicon/route.ts');
  const middleware = read('src/middleware.ts');
  const staticFavicon = readFileSync(join(root, 'src/app/favicon.ico'));

  assert.match(favicon, /fill="#2563eb"/);
  assert.doesNotMatch(favicon, /fill="#111827"/);
  assert.doesNotMatch(favicon, /<rect[^>]+fill="#111827"/);
  assert.match(middleware, /setupAllowedPaths[\s\S]*'\/api\/branding\/favicon'/);
  assert.match(middleware, /setupAllowedPaths[\s\S]*'\/api\/dns-providers\/cloudflare\/validate'/);
  assert.ok(staticFavicon.length > 1000);
});

test('IP setup-complete routing uses IPv4 loopback and completed login handoff', () => {
  const middleware = read('src/middleware.ts');
  const login = read('src/components/auth/login-form.tsx');

  assert.match(middleware, /http:\/\/127\.0\.0\.1:3000\/api\/setup\/config/);
  assert.doesNotMatch(middleware, /http:\/\/localhost:3000\/api\/setup\/config/);
  assert.match(middleware, /setup completion check failed; treating setup as incomplete/);
  assert.match(login, /fetch\('\/api\/setup\/config', \{ cache: 'no-store' \}\)/);
  assert.match(login, /setupConfig\.setup_completed \? '\/setup-complete' : '\/setup'/);
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
