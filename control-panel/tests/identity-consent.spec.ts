import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('YouEye ID stores first-launch app consent per user and client', () => {
  const store = read('src/lib/identity/store.ts');

  assert.match(store, /CREATE TABLE IF NOT EXISTS identity_app_consents/);
  assert.match(store, /PRIMARY KEY \(user_id, client_id\)/);
  assert.match(store, /getAppConsent/);
  assert.match(store, /upsertAppConsent/);
  assert.match(store, /revokeAppConsent/);
  assert.match(store, /getUserByUsername/);
});

test('OAuth authorize requires consent for app clients before issuing codes', () => {
  const authorize = read('src/app/application/o/authorize/route.ts');

  assert.match(authorize, /FIRST_PARTY_CLIENTS = new Set\(\['youeye-control', 'youeye-ui'\]\)/);
  assert.match(authorize, /getAppConsent\(user\.id, clientId\)/);
  assert.match(authorize, /consentHtml/);
  assert.match(authorize, /upsertAppConsent\(\{ userId: user\.id, clientId, scopes: scopeList\(scope\) \}\)/);
  assert.match(authorize, /access_denied/);
  assert.match(authorize, /issueAuthRedirect/);
});

test('App settings can list and revoke YouEye ID first-launch consent', () => {
  const consentRoute = read('src/app/api/identity/consents/app/[appId]/route.ts');
  const appSettings = read('src/components/settings-shell/apps-client.tsx');

  assert.match(consentRoute, /getIdentitySession/);
  assert.match(consentRoute, /getSession/);
  assert.match(consentRoute, /getUserByUsername/);
  assert.match(consentRoute, /getAppConsent/);
  assert.match(consentRoute, /revokeAppConsent/);
  assert.match(consentRoute, /identity:youeye-id:sign-in/);
  assert.match(consentRoute, /Sign in with YouEye ID/);
  assert.match(consentRoute, /descriptor/);
  assert.match(consentRoute, /first-launch/);
  assert.match(appSettings, /identityConsentApi/);
  assert.match(appSettings, /settings\/api/);
  assert.match(appSettings, /identity:youeye-id:sign-in/);
  assert.match(appSettings, /permissionTitle/);
  assert.match(appSettings, /permissionDescription/);
  assert.match(appSettings, /risk/);
});
