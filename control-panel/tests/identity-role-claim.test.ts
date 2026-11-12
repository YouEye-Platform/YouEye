// Per-app role claims (manifest `sso.role_claim`, stored on the app's OAuth client): sent only when the granted scope
// asks for the claim; admins get admin_value, everyone else default_value; list values stay lists.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isIdentityAdmin, roleClaims } from '../src/lib/identity/tokens';
import type { IdentityUser } from '../src/lib/identity/store';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const user = (groups: string[], isAdmin = false) => ({ username: 'u', groups, is_admin: isAdmin }) as unknown as IdentityUser;
const admin = user(['youeye-users', 'admin']);
const standard = user(['youeye-users']);

test('a string role claim is sent when its scope is granted', () => {
  const immich = { claim: 'immich_role', admin_value: 'admin', default_value: 'user' };
  assert.deepEqual(roleClaims(admin, 'openid email immich_role', immich), { immich_role: 'admin' });
  assert.deepEqual(roleClaims(standard, 'openid immich_role profile', immich), { immich_role: 'user' });
  assert.deepEqual(roleClaims(admin, 'openid email profile', immich), {});
  assert.deepEqual(roleClaims(admin, 'openid immich_role', null), {});
});

test('a list role claim is sent as an array, and only the app\'s own claim is honoured', () => {
  const abs = { claim: 'abs_roles', admin_value: ['admin'], default_value: ['user'] };
  assert.deepEqual(roleClaims(admin, 'openid profile email abs_roles', abs), { abs_roles: ['admin'] });
  assert.deepEqual(roleClaims(standard, 'openid profile email abs_roles', abs), { abs_roles: ['user'] });
  // Another *_role scope never produces a claim (the old suffix rule is gone).
  assert.deepEqual(roleClaims(admin, 'openid other_role', abs), {});
  // A stored client whose role claim names a standard claim never sends it (it would replace sub, groups, …).
  for (const claim of ['sub', 'groups', 'is_admin', 'Email']) {
    assert.deepEqual(roleClaims(admin, `openid ${claim}`, { ...abs, claim }), {});
  }
});

test('admins are the is_admin flag or the exact admin group', () => {
  assert.equal(isIdentityAdmin(admin), true);
  assert.equal(isIdentityAdmin(user([], true)), true);
  assert.equal(isIdentityAdmin(standard), false);
  assert.equal(isIdentityAdmin(user(['sysadmins', 'not-admin'])), false);
});

test('userinfo and discovery use the client\'s own role claim and scopes', () => {
  const userinfo = readFileSync(path.join(root, 'src/app/application/o/userinfo/route.ts'), 'utf8');
  assert.match(userinfo, /roleClaims\(user, scope, client\?\.role_claim\)/);
  const discovery = readFileSync(path.join(root, 'src/app/application/o/[clientId]/.well-known/openid-configuration/route.ts'), 'utf8');
  assert.match(discovery, /scopes_supported: client\.scopes/);
  assert.doesNotMatch(discovery, /immich_role/);
  // Fetched through the public identity host, the back-channel endpoints are the public ones.
  assert.match(discovery, /viaPublicHost \? null : getAppInternalIdentityBase\(clientId\)/);
});
