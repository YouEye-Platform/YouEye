import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('first-browser claim has one atomic owner slot and no domain dependency', () => {
  const store = read('src/lib/identity/store.ts');
  const route = read('src/app/api/appliance/claim/route.ts');
  const client = read('src/components/auth/appliance-claim.tsx');
  const tokens = read('src/lib/identity/tokens.ts');

  assert.match(store, /identity_appliance_claim/);
  assert.match(store, /singleton boolean PRIMARY KEY/);
  assert.match(store, /WITH available AS[\s\S]*SELECT singleton[\s\S]*owner_user_id IS NULL[\s\S]*FOR UPDATE/);
  assert.match(store, /created AS[\s\S]*INSERT INTO identity_users/);
  assert.match(store, /linked AS[\s\S]*UPDATE identity_appliance_claim[\s\S]*SET owner_user_id = created\.id,[\s\S]*claimed_at = now\(\)/);
  assert.equal((store.match(/UPDATE identity_appliance_claim c/g) || []).length, 1);
  assert.doesNotMatch(route, /getIdentityConfig|createIdentityToken/);
  assert.match(route, /createSetupSession/);
  assert.match(store, /first_name text NOT NULL/);
  assert.match(store, /last_name text NOT NULL DEFAULT ''/);
  assert.match(route, /firstName/);
  assert.match(route, /lastName/);
  assert.match(client, /autoComplete="given-name"/);
  assert.match(client, /autoComplete="family-name"/);
  assert.match(client, /min-h-screen/);
  assert.match(tokens, /given_name: user\.first_name/);
  assert.match(tokens, /family_name: user\.last_name/);
});

test('identity schema upgrades existing users before enforcing split-name constraints', () => {
  const store = read('src/lib/identity/store.ts');
  const addFirstName = store.indexOf('ADD COLUMN IF NOT EXISTS first_name text');
  const addLastName = store.indexOf('ADD COLUMN IF NOT EXISTS last_name text');
  const backfill = store.indexOf("SET first_name = COALESCE(NULLIF(btrim(first_name), ''), NULLIF(btrim(name), ''), username)");
  const enforce = store.indexOf('ALTER COLUMN first_name SET NOT NULL');

  assert.ok(addFirstName > 0);
  assert.ok(addLastName > addFirstName);
  assert.ok(backfill > addLastName);
  assert.ok(enforce > backfill);
  assert.match(store, /last_name = COALESCE\(last_name, ''\)/);
  assert.match(store, /ALTER COLUMN last_name SET DEFAULT ''/);
  assert.match(store, /ALTER COLUMN last_name SET NOT NULL/);
});

test('claim and resume are local, origin-bound, CSRF protected, and rate limited', () => {
  const route = read('src/app/api/appliance/claim/route.ts');
  const mode = read('src/lib/auth/mode.ts');

  assert.match(route, /isApplianceSetupHost/);
  assert.match(route, /origin === `\$\{protocol\}:\/\/\$\{host\}`/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /checkRateLimit/);
  assert.match(route, /verifyApplianceOwner/);
  assert.match(mode, /port !== '3000'/);
});

test('setup session is scoped and setup mutations use a durable single-writer lease', () => {
  const session = read('src/lib/auth/session.ts');
  const middleware = read('src/middleware.ts');
  const setup = read('src/app/api/setup/run/route.ts');

  assert.match(session, /authMethod: 'setup'/);
  assert.match(session, /SETUP_SESSION_DURATION/);
  assert.match(middleware, /setupSessionAllows/);
  assert.match(middleware, /restricted to appliance onboarding/);
  assert.match(setup, /acquireSetupOperation/);
  assert.match(setup, /heartbeatSetupOperation/);
  assert.match(setup, /releaseSetupOperation/);
  assert.match(setup, /markApplianceSetupComplete/);
  assert.doesNotMatch(setup, /admin_password|ensureIdentityAdminUser/);
});

test('domain handoff is short-lived, hashed, single-use, and posted outside the URL', () => {
  const store = read('src/lib/identity/store.ts');
  const complete = read('src/app/setup-complete/page.tsx');
  const handoff = read('src/app/identity/handoff/route.ts');

  assert.match(store, /createHash\('sha256'\)\.update\(code\)/);
  assert.match(store, /now\(\) \+ interval '5 minutes'/);
  assert.match(store, /used_at IS NULL/);
  assert.match(store, /SET used_at = now\(\)/);
  assert.match(complete, /form\.method = 'POST'/);
  assert.match(complete, /code\.type = 'hidden'/);
  assert.doesNotMatch(complete, /searchParams\.set\(['"]code/);
  assert.match(handoff, /consumeSetupHandoff/);
  assert.match(handoff, /setIdentityCookie/);
  assert.match(handoff, /x-forwarded-host/);
  assert.match(handoff, /x-forwarded-proto/);
  assert.match(handoff, /candidate !== expectedOrigin/);
  assert.match(handoff, /isTrustedHandoffBrowserOrigin/);
});

test('YouEye ID uses one 8-256 password policy across claim, stores, compatibility APIs, bridge, and Settings', () => {
  const policy = read('src/lib/identity/password-policy.ts');
  const store = read('src/lib/identity/store.ts');
  const claim = read('src/app/api/appliance/claim/route.ts');
  const compatibilityUsers = read('src/app/api/apps/identity/users/route.ts');
  const compatibilityUser = read('src/app/api/apps/identity/users/[id]/route.ts');
  const compatibilityPassword = read('src/app/api/apps/identity/users/[id]/password/route.ts');
  const bridgeUsers = read('src/app/api/ui-bridge/users/route.ts');
  const bridgeUser = read('src/app/api/ui-bridge/users/[id]/route.ts');
  const client = read('src/components/settings-shell/users-client.tsx');

  assert.match(policy, /IDENTITY_PASSWORD_MIN_LENGTH = 8/);
  assert.match(policy, /IDENTITY_PASSWORD_MAX_LENGTH = 256/);
  assert.match(store, /requireIdentityPassword/);
  assert.match(claim, /validateIdentityPassword/);
  assert.match(compatibilityUsers, /session\.isAdmin/);
  assert.match(compatibilityUsers, /verifyCSRFToken/);
  assert.match(compatibilityUser, /session\?\.isAdmin/);
  assert.match(compatibilityUser, /verifyCSRFToken/);
  assert.match(compatibilityPassword, /session\.isAdmin/);
  assert.match(compatibilityPassword, /verifyCSRFToken/);
  assert.match(bridgeUsers, /validateIdentityPassword/);
  assert.match(bridgeUser, /validateIdentityPassword/);
  assert.match(client, /validateIdentityPassword/);
  assert.match(client, /X-CSRF-Token/);
});

test('claimed onboarding offers signed system update, packaged continuation, and protected backup restore', () => {
  const setup = read('src/app/setup/page.tsx');
  const update = read('src/components/setup/SetupApplianceUpdate.tsx');
  const restore = read('src/app/api/setup/restore/route.ts');

  assert.match(setup, /SetupApplianceUpdate/);
  assert.match(setup, /goToStep\(-1\)/);
  assert.match(setup, /SetupRestore/);
  assert.match(update, /Continue with packaged version/);
  assert.match(update, /Update now/);
  assert.match(update, /system-update\/source/);
  assert.match(update, /JSON\.stringify\(source\)/);
  assert.match(update, /system-update\/stage/);
  assert.match(update, /system-update\/activate/);
  assert.match(restore, /session\?\.isAdmin/);
  assert.match(restore, /session\.setupOwnerId/);
  assert.match(restore, /verifyCSRFToken/);
  assert.match(restore, /realpath/);
  assert.match(restore, /\/var\/lib\/youeye\/backups/);
});

test('first-user onboarding is Control Panel-native and has no avatar iframe', () => {
  const page = read('src/app/onboarding/page.tsx');
  const client = read('src/components/onboarding/onboarding-client.tsx');

  assert.match(page, /OnboardingClient/);
  assert.match(client, /ProfileIconPicker/);
  assert.match(client, /\/api\/ui-settings\/onboarding\/complete/);
  assert.match(client, /\/api\/user\/avatar/);
  assert.doesNotMatch(client, /iframe|postMessage|embed\/avatar/);
  assert.equal(existsSync(join(root, 'src/app/embed/avatar/page.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/avatar/client.tsx')), false);
});
