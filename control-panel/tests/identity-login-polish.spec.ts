import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('identity login uses configured provider name as the visible wordmark', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.match(route, /getIdentityProviderConfig/);
  assert.match(route, /<div class="wordmark">\$\{escapeHtml\(provider\.name\)\}<\/div>/);
  assert.doesNotMatch(route, />YouEye ID</);
});

test('identity login derives app context from OAuth client or return host', () => {
  const route = read('src/app/identity/login/route.ts');

  assert.match(route, /resolveLoginContext/);
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
  assert.doesNotMatch(route, />client_id</);
});
