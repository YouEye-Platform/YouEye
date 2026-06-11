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

test('OAuth authorize can show and grant selected runtime app permissions', () => {
  const authorize = read('src/app/application/o/authorize/route.ts');

  assert.match(authorize, /appIdFromClientId/);
  assert.match(authorize, /\/api\/ui-bridge\/app-launch-permissions/);
  assert.match(authorize, /name="runtime_permission"/);
  assert.match(authorize, /class="switch"/);
  assert.match(authorize, /also wants to:/);
  assert.match(authorize, /form\.getAll\('runtime_permission'\)/);
  assert.match(authorize, /grantPermissions: selectedRuntimePermissions/);
  assert.match(authorize, /denyUnselected: Array\.isArray\(input\.grantPermissions\)/);
  assert.match(authorize, /identityUserId: input\.user\.id/);
  assert.match(authorize, /username: input\.user\.username/);
  assert.match(authorize, /email: input\.user\.email/);
  assert.match(authorize, /NextResponse\.redirect\(redirect, \{ status: 303 \}\)/);
  assert.match(authorize, /failed_to_update_app_permissions/);
});

test('OAuth consent presents a simple account handoff without technical scope UI', () => {
  const authorize = read('src/app/application/o/authorize/route.ts');

  assert.match(authorize, /<h1>Sign in to \$\{escapeHtml\(appName\)\}<\/h1>/);
  assert.match(authorize, /class="app-brand"/);
  assert.match(authorize, /appMark\(params\.display\?\.app, appName\)/);
  assert.match(authorize, /class="account"/);
  assert.match(authorize, /accountAvatar\(params\.display\?\.user, accountLabel\)/);
  assert.match(authorize, /will share your/);
  assert.match(authorize, /You can revoke access later in app settings/);
  assert.match(authorize, />Cancel<\/button>/);
  assert.match(authorize, />Continue<\/button>/);
  assert.match(authorize, /display: runtime\?\.display/);
  assert.doesNotMatch(authorize, /class="relationship"/);
  assert.doesNotMatch(authorize, /class="provider"/);
  assert.doesNotMatch(authorize, /provider-name/);
  assert.doesNotMatch(authorize, /Basic access/);
  assert.doesNotMatch(authorize, /Technical details/);
  assert.doesNotMatch(authorize, /<details>/);
  assert.doesNotMatch(authorize, /scope-chips/);
  assert.doesNotMatch(authorize, /risk<\/span>/);
  assert.doesNotMatch(authorize, /<li><span>\$\{escapeHtml\(label\)\}<\/span><code>/);
});

test('Fresh installs push connection candidates to UI after dashboard registration', () => {
  const engine = read('src/lib/market/engine.ts');

  assert.match(engine, /pushConnectionsToUI/);
  assert.match(engine, /await registerAppWithUI/);
  assert.match(engine, /await pushConnectionsToUI\(appId\)/);
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
  assert.match(consentRoute, /Sign in with \$\{provider\.name\}/);
  assert.match(consentRoute, /descriptor/);
  assert.match(consentRoute, /first-launch/);
  assert.match(appSettings, /identityConsentApi/);
  assert.match(appSettings, /settings\/api/);
  assert.match(appSettings, /identity:youeye-id:sign-in/);
  assert.match(appSettings, /permissionTitle/);
  assert.match(appSettings, /permissionDescription/);
  assert.match(appSettings, /risk/);
});
