import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('Settings login redirects to SSO on the server when subdomain auth is active', () => {
  const settingsLoginPage = read('src/app/settings/login/page.tsx');

  assert.match(settingsLoginPage, /getAuthModeForHost\(host\) === 'sso'/);
  assert.match(settingsLoginPage, /redirect\(`\/settings\/api\/auth\/sso\?redirect=\$\{encodeURIComponent\(returnTo\)\}`\)/);
  assert.doesNotMatch(settingsLoginPage, /useEffect/);
  assert.doesNotMatch(settingsLoginPage, /window\.location/);
  assert.doesNotMatch(settingsLoginPage, /redirectingToSSO/);
});

test('Control login shares the server-side SSO auth mode helper', () => {
  const loginPage = read('src/app/login/page.tsx');
  const authModeRoute = read('src/app/api/auth/mode/route.ts');
  const authModeHelper = read('src/lib/auth/mode.ts');

  assert.match(loginPage, /getAuthModeForHost\(host\) === 'sso'/);
  assert.match(loginPage, /redirect\(`\/api\/auth\/sso\?redirect=\$\{encodeURIComponent\(returnTo\)\}`\)/);
  assert.match(authModeRoute, /getAuthModeForHost\(host\)/);
  assert.match(authModeHelper, /isIPAccessHost/);
  assert.match(authModeHelper, /isSSOConfigured\(\)/);
});

test('PAM login form no longer performs client-side SSO detection', () => {
  const loginForm = read('src/components/auth/login-form.tsx');

  assert.doesNotMatch(loginForm, /\/mode/);
  assert.doesNotMatch(loginForm, /Redirecting to SSO/);
  assert.doesNotMatch(loginForm, /window\.location\.href/);
  assert.match(loginForm, /settingsFlow \? '\/settings\/api\/auth' : '\/api\/auth'/);
});
