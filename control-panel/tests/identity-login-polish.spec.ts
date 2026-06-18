import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('identity login uses the server name as the visible wordmark', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.match(route, /getIdentityProviderConfig/);
  assert.match(route, /wordmarkMarkup\(branding\.siteName, branding\.siteNameStyle\)/);
  assert.match(route, /renderWordmark\(siteName, style\)/);
  assert.doesNotMatch(route, />YouEye ID</);
});

test('identity login renders the server WordArt style and font assets', () => {
  const route = read('src/app/identity/login/route.ts');
  const middleware = read('src/middleware.ts');

  assert.match(route, /api\/ui-bridge\/branding/);
  assert.match(route, /identityBranding/);
  assert.match(route, /DEFAULT_STYLE/);
  assert.match(route, /CHARACTER_SHAPE_PRESETS/);
  assert.match(route, /raw\.site_name_style/);
  assert.match(route, /FONT_CSS_MAP/);
  assert.match(route, /<link rel="stylesheet" href="\$\{escapeHtml\(fontHref\)\}" \/>/);
  assert.match(route, /background-image: linear-gradient/);
  assert.match(route, /-webkit-text-stroke/);
  assert.match(route, /charShape\.charTransform/);
  assert.match(route, /<header class="brand"/);
  assert.match(route, /width: min\(760px, 100%\)/);
  assert.match(middleware, /white-label login can load its local WordArt font CSS\/assets/);
});

test('identity login keeps the WordArt outside the form panel', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.match(route, /<header class="brand"[\s\S]*\$\{wordmark\.html\}[\s\S]*<\/header>\s*<section class="panel">/);
  assert.doesNotMatch(route, /class="identity"/);
  assert.doesNotMatch(route, /identity-pill/);
  assert.doesNotMatch(route, /Private account login/);
  assert.doesNotMatch(route, /Need help/);
});

test('identity login derives app context from OAuth client or return host', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.match(route, /resolveLoginContext/);
  assert.match(route, /CORE_CLIENT_IDS/);
  assert.match(route, /if \(CORE_CLIENT_IDS\.has\(clientId\)\) return serverName/);
  assert.match(route, /getClient\(clientId\)/);
  assert.match(route, /appNameFromClientId/);
  assert.match(route, /appNameFromHost/);
  assert.match(route, /Continue to \$\{appName\}/);
});

test('identity login button morphs to continuing state on submit', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.match(route, /data-loading-text="Continuing\.\.\."/);
  assert.match(route, /button\.textContent = button\.dataset\.loadingText/);
  assert.match(route, /button\.setAttribute\('disabled', 'true'\)/);
});

test('identity login keeps technical context out of primary copy', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.doesNotMatch(route, />OAuth</);
  assert.doesNotMatch(route, />OIDC</);
  assert.doesNotMatch(route, /<[^>]*>[^<]*client_id[^<]*</);
});
