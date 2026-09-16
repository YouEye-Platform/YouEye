import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
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

test('development access can only be inspected or disabled by an administrator', () => {
  const route = source('src/app/api/appliance/development-access/route.ts');
  const card = source('src/components/settings-shell/development-access-card.tsx');
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /session\?\.isAdmin/);
  assert.match(route, /verifyCSRFToken/);
  assert.match(route, /status: 403/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH)/);
  assert.match(card, /Enable access or change the password locally on the device/);
  assert.match(card, /method: "DELETE"/);
  assert.match(card, /X-CSRF-Token/);
});

test('development access reports applied TTY2 state without treating a request as enabled', () => {
  const client = source('src/lib/spine/client.ts');
  const card = source('src/components/settings-shell/development-access-card.tsx');
  assert.match(client, /schema: 'youeye\.development-access-status\.v2'/);
  for (const field of [
    'local_root_console_requested',
    'local_root_console_persisted',
    'local_root_console_active',
    'local_root_console_effective',
    'root_password_ssh_requested',
    'root_password_ssh_effective',
  ]) assert.match(client, new RegExp(`${field}: boolean`));
  assert.match(card, /Local root console \(TTY2\)/);
  assert.match(card, /Requested/);
  assert.match(card, /Active now/);
  assert.match(card, /status\.local_root_console_requested && !status\.local_root_console_effective/);
  assert.match(card, /!status\.local_root_console_requested && status\.local_root_console_active/);
  assert.match(card, /Requested local console access is not effective yet/);
  assert.match(card, /Local console access remains active while its policy is off/);
  assert.doesNotMatch(card, /local_root_console_requested\)} detail=/);
});
