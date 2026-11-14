import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string) {
  return englishInterfaceSource(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

test('host bootstrap network status is administrator-only and read-only', () => {
  const route = source('src/app/api/appliance/network/route.ts');
  const compatibilityRoute = source('src/app/settings/api/appliance/network/route.ts');
  assert.match(route, /export async function GET/);
  assert.match(route, /session\?\.isAdmin/);
  assert.match(route, /status: 403/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(compatibilityRoute, /export \{ GET \}/);
});

test('console access settings are administrator-only and CSRF-protected', () => {
  const route = source('src/app/api/appliance/console-access/route.ts');
  const password = source('src/app/api/appliance/console-access/password/route.ts');
  for (const handler of [route, password]) {
    assert.match(handler, /session\?\.isAdmin/);
    assert.match(handler, /status: 403/);
    assert.doesNotMatch(handler, /export async function (POST|PATCH|DELETE)/);
  }
  assert.match(route, /export async function GET\(\)[\s\S]*session\?\.isAdmin[\s\S]*export async function PUT/);
  assert.match(route, /export async function PUT[\s\S]*verifyCSRFToken/);
  assert.match(password, /export async function PUT[\s\S]*verifyCSRFToken/);
  // An admin sets only their own console password.
  assert.match(password, /setConsolePassword\(session\.identityId/);
  assert.match(source('src/app/settings/api/appliance/console-access/route.ts'), /export \{ GET, PUT \}/);
  assert.match(source('src/app/settings/api/appliance/console-access/password/route.ts'), /export \{ PUT \}/);
});

test('the console access card explains box sign-in and keeps root and password SSH advanced', () => {
  const card = source('src/components/settings-shell/console-access-card.tsx');
  const system = source('src/components/settings-shell/system-client.tsx');
  assert.match(system, /isAppliance && <ConsoleAccessCard \/>/);
  assert.match(card, /Admins can sign in on the box's screen \(Ctrl\+Alt\+F2\) with their YouEye ID password, even when the Control Panel is down\./);
  assert.match(card, /\/settings\/api\/appliance\/console-access/);
  assert.match(card, /X-CSRF-Token/);
  assert.match(card, /\{advanced && view && \([\s\S]*rootPassword[\s\S]*passwordSSH/);
  assert.doesNotMatch(card, /password_hash|PasswordHash/);
});

test('development access is gone from the Control Panel', () => {
  const client = source('src/lib/spine/client.ts');
  assert.doesNotMatch(client, /development-access|DevelopmentAccess|local_root_console|root_password_ssh/);
  for (const method of ['consoleStatus', 'syncConsoleAdmins', 'setConsolePassword', 'updateConsoleSettings', 'useOwnerResetCode']) {
    assert.match(client, new RegExp(`async ${method}\\(`));
  }
  assert.match(client, /'\/api\/console\/accounts\/sync', 'POST'/);
  assert.match(client, /'\/api\/console\/owner-reset', 'POST'/);
});
