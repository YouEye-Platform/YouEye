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
  assert.match(authorize, /identityFaviconLinks\(\)/);
  assert.match(authorize, /class="app-brand"/);
  assert.match(authorize, /appBrand\(params\.display\?\.app, appName, params\.uiExternalUrl \?\? null\)/);
  assert.match(authorize, /class="app-icon/);
  assert.match(authorize, /appNameMarkup/);
  assert.match(authorize, /branding_css/);
  assert.match(authorize, /branding_font_url/);
  assert.match(authorize, /class="account"/);
  assert.match(authorize, /uiExternalUrl: externalUiUrl/);
  assert.match(authorize, /accountAvatar\(params\.display\?\.user, accountLabel, params\.uiExternalUrl \?\? null\)/);
  assert.match(authorize, /avatar_path/);
  assert.match(authorize, /will share your/);
  assert.match(authorize, /You can revoke access later in app settings/);
  assert.match(authorize, />Cancel<\/button>/);
  assert.match(authorize, />Continue<\/button>/);
  assert.match(authorize, /display: runtime\?\.display/);
  assert.doesNotMatch(authorize, /appMark/);
  assert.doesNotMatch(authorize, /app-mark/);
  assert.doesNotMatch(authorize, /class="relationship"/);
  assert.doesNotMatch(authorize, /class="provider"/);
  assert.doesNotMatch(authorize, /provider-name/);
  assert.doesNotMatch(authorize, /Basic access/);
  assert.doesNotMatch(authorize, /Technical details/);
  assert.doesNotMatch(authorize, /<details>/);
  assert.doesNotMatch(authorize, /scope-chips/);
  assert.doesNotMatch(authorize, /risk<\/span>/);
  assert.doesNotMatch(authorize, /<li><span>\$\{escapeHtml\(label\)\}<\/span><code>/);
  assert.doesNotMatch(authorize, /href="data:,"/);
});

test('YouEye ID allows branded favicon and root-domain account avatar images', () => {
  const favicon = read('src/lib/identity/favicon.ts');
  const middleware = read('src/middleware.ts');

  assert.match(favicon, /\/api\/branding\/favicon\?size=32/);
  assert.match(favicon, /\/api\/branding\/favicon\?size=16/);
  assert.match(favicon, /\/api\/branding\/favicon\?size=180/);
  assert.match(middleware, /IDENTITY_SERVICE_ROUTES[\s\S]*'\/api\/branding\/favicon'/);
  assert.match(middleware, /function getUiAssetOrigin\(request\?: NextRequest\)/);
  assert.match(middleware, /process\.env\.UI_EXTERNAL_URL/);
  assert.match(middleware, /process\.env\.CONTROL_EXTERNAL_URL/);
  assert.match(middleware, /process\.env\.IDENTITY_URL/);
  assert.match(middleware, /rootOriginFromIdentityHost/);
  assert.match(middleware, /request\.headers\.get\('x-forwarded-host'\)/);
  assert.match(middleware, /img-src \$\{imageSourcesForCsp\(request\)\}/);
  assert.doesNotMatch(middleware, /byka\.wtf/);
  assert.doesNotMatch(middleware, /devvm\.test/);
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
