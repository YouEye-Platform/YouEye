import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { consoleAdmins, consolePasswordError, createConsoleAccess, type ConsoleAccessDeps } from '../src/lib/console-access';
import { resetOwnerPassword, type OwnerResetDeps } from '../src/lib/console-access/owner-reset';
import { SpineAPIError, type SpineConsoleStatus } from '../src/lib/spine/client';
import type { IdentityUser } from '../src/lib/identity/store';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const OWNER = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';
const SECRET = 'correct horse battery staple';

function user(id: string, username: string, patch: Partial<IdentityUser> = {}): IdentityUser {
  return { id, username, name: username, first_name: username, last_name: '', email: '', groups: ['youeye-users'],
    is_admin: false, is_active: true, ...patch };
}

/** A fake Spine that applies Sync and SetPassword like spine/internal/consoleaccess. */
function fakeBox(users: IdentityUser[], options: { appliance?: boolean; failSync?: boolean } = {}) {
  const accounts = new Map<string, { username: string; admin: boolean; hash: boolean }>();
  const calls = { syncs: [] as string[][], passwords: [] as Array<{ userId: string; password: string }>, logs: [] as string[] };
  const stale = new Set<string>();
  const status = (): SpineConsoleStatus => ({
    accounts: [...accounts].map(([user_id, a]) => ({ user_id, username: a.username, admin: a.admin, locked: !a.admin || !a.hash, has_password: a.hash })),
    root_password_set: false, password_ssh: false, owner_reset_pending: false,
  });
  const notAppliance = () => new SpineAPIError('managed remote access is available only on a sealed appliance', 409, 'appliance_required');
  const deps: ConsoleAccessDeps = {
    listUsers: async () => users,
    log: message => { calls.logs.push(message); },
    stale: {
      add: async id => { stale.add(id); },
      list: async () => [...stale],
      remove: async id => { stale.delete(id); },
    },
    spine: {
      consoleStatus: async () => {
        if (options.appliance === false) throw notAppliance();
        return status();
      },
      syncConsoleAdmins: async admins => {
        if (options.failSync) throw new Error('Control Panel could not reach the Spine API');
        calls.syncs.push(admins.map(admin => admin.user_id));
        const wanted = new Set(admins.map(admin => admin.user_id));
        for (const admin of admins) {
          const account = accounts.get(admin.user_id);
          if (account) account.admin = true;
          else accounts.set(admin.user_id, { username: admin.username, admin: true, hash: false });
        }
        for (const [id, account] of accounts) if (!wanted.has(id)) account.admin = false;
        return status();
      },
      setConsolePassword: async (userId, password) => {
        const account = accounts.get(userId);
        if (!account?.admin) throw new SpineAPIError('only an admin has a console account', 409);
        calls.passwords.push({ userId, password });
        account.hash = password !== '';
        return status();
      },
    },
  };
  return { deps, calls, accounts, users, stale };
}

test('only active YouEye ID admins (flag or admin group) get console accounts', () => {
  const admins = consoleAdmins([
    user(BOB, 'bob', { groups: ['admin'] }),
    user(OWNER, 'owner', { is_admin: true }),
    user(ALICE, 'alice', { is_admin: true, is_active: false }),
    user('44444444-4444-4444-8444-444444444444', 'carol'),
  ]);
  assert.deepEqual(admins, [{ user_id: OWNER, username: 'owner' }, { user_id: BOB, username: 'bob' }]);
});

test('sync sends the full admin set after promote, demote and delete, and only when it changed', async () => {
  const users = [user(OWNER, 'owner', { is_admin: true }), user(ALICE, 'alice')];
  const box = fakeBox(users);
  const access = createConsoleAccess(box.deps);

  assert.equal(await access.syncConsoleAdmins(), true);
  assert.deepEqual(box.calls.syncs, [[OWNER]]);
  await access.syncConsoleAdmins();
  assert.equal(box.calls.syncs.length, 1, 'an unchanged admin set is not posted again');

  users[1] = { ...users[1], is_admin: true }; // promote
  await access.afterIdentityChange({ userId: ALICE });
  assert.deepEqual(box.calls.syncs.at(-1), [OWNER, ALICE]);

  users[1] = { ...users[1], is_admin: false }; // demote
  await access.afterIdentityChange({ userId: ALICE });
  assert.deepEqual(box.calls.syncs.at(-1), [OWNER]);
  assert.equal(box.accounts.get(ALICE)?.admin, false);

  users[1] = { ...users[1], is_admin: true };
  await access.afterIdentityChange({ userId: ALICE });
  users.splice(1, 1); // delete
  await access.afterIdentityChange({ userId: ALICE });
  assert.deepEqual(box.calls.syncs.at(-1), [OWNER]);

  users[0] = { ...users[0], is_active: false }; // a disabled admin is locked too
  await access.syncConsoleAdmins();
  assert.deepEqual(box.calls.syncs.at(-1), []);
});

test('a password is sent as the console password only for an admin', async () => {
  const users = [user(OWNER, 'owner', { is_admin: true }), user(ALICE, 'alice')];
  const box = fakeBox(users);
  const access = createConsoleAccess(box.deps);

  await access.afterIdentityChange({ userId: ALICE, password: SECRET });
  assert.deepEqual(box.calls.passwords, []);

  await access.afterIdentityChange({ userId: OWNER, password: SECRET });
  assert.deepEqual(box.calls.passwords, [{ userId: OWNER, password: SECRET }]);

  // A new admin created with a password: the sync makes the account first, then the password unlocks it.
  users.push(user(BOB, 'bob', { is_admin: true }));
  await access.afterIdentityChange({ userId: BOB, password: SECRET });
  assert.deepEqual(box.calls.syncs.at(-1), [OWNER, BOB]);
  assert.equal(box.calls.passwords.at(-1)?.userId, BOB);
  assert.equal(box.accounts.get(BOB)?.hash, true);

  await access.afterIdentityChange({ userId: OWNER });
  assert.equal(box.calls.passwords.length, 2, 'a change without a password sends none');
});

test('off a sealed appliance console access is a no-op', async () => {
  const box = fakeBox([user(OWNER, 'owner', { is_admin: true })], { appliance: false });
  const access = createConsoleAccess(box.deps);
  assert.equal(await access.syncConsoleAdmins(), true);
  await access.afterIdentityChange({ userId: OWNER, password: SECRET });
  assert.deepEqual(box.calls.syncs, []);
  assert.deepEqual(box.calls.passwords, []);
  assert.deepEqual(box.calls.logs, []);
});

test('a Spine failure never throws, is logged without the password, and the next sync repairs it', async () => {
  const users = [user(OWNER, 'owner', { is_admin: true })];
  const box = fakeBox(users, { failSync: true });
  const access = createConsoleAccess(box.deps);
  assert.equal(await access.syncConsoleAdmins(), false);
  await access.afterIdentityChange({ userId: OWNER, password: SECRET });
  assert.ok(box.calls.logs.length >= 2);
  assert.ok(box.calls.logs.every(line => !line.includes(SECRET)));

  const repaired = fakeBox(users);
  const later = createConsoleAccess(repaired.deps);
  assert.equal(await later.syncConsoleAdmins(), true);
  assert.deepEqual(repaired.calls.syncs, [[OWNER]]);
});

test('a refused console password is logged without the plaintext and the old one is cleared', async () => {
  const box = fakeBox([user(OWNER, 'owner', { is_admin: true })]);
  const access = createConsoleAccess(box.deps);
  await access.afterIdentityChange({ userId: OWNER, password: SECRET });
  assert.equal(box.accounts.get(OWNER)?.hash, true);
  const send = box.deps.spine.setConsolePassword;
  box.deps.spine.setConsolePassword = async (userId, password) => {
    if (password) throw new SpineAPIError('console password must be 8 to 1024 characters on one line', 409);
    return send(userId, password);
  };
  await access.afterIdentityChange({ userId: OWNER, password: 'a new leaked one' });
  assert.equal(box.calls.logs.length, 1);
  assert.match(box.calls.logs[0], /not sent/);
  assert.doesNotMatch(box.calls.logs[0], new RegExp(SECRET));
  assert.equal(box.accounts.get(OWNER)?.hash, false, 'the old console password must stop working');
  assert.equal(box.stale.size, 0);
});

test('a password that never reached Spine clears the console password at the next sync', async () => {
  const users = [user(OWNER, 'owner', { is_admin: true })];
  const box = fakeBox(users);
  const access = createConsoleAccess(box.deps);
  await access.afterIdentityChange({ userId: OWNER, password: SECRET });
  const sync = box.deps.spine.syncConsoleAdmins, status = box.deps.spine.consoleStatus;
  box.deps.spine.consoleStatus = async () => { throw new Error('Control Panel could not reach the Spine API'); };
  await access.afterIdentityChange({ userId: OWNER, password: 'changed while Spine was down' });
  assert.deepEqual([...box.stale], [OWNER]);
  assert.equal(box.accounts.get(OWNER)?.hash, true);
  box.deps.spine.consoleStatus = status;
  box.deps.spine.syncConsoleAdmins = sync;
  assert.equal(await access.syncConsoleAdmins(), true);
  assert.equal(box.accounts.get(OWNER)?.hash, false);
  assert.equal(box.stale.size, 0);
  assert.ok(box.calls.logs.every(line => !line.includes('changed while Spine was down')));
});

test('console passwords follow Spine\'s rule', () => {
  assert.equal(consolePasswordError('12345678'), null);
  assert.ok(consolePasswordError('short'));
  assert.ok(consolePasswordError('line one\nline two'));
  assert.ok(consolePasswordError('x'.repeat(1025)));
  assert.ok(consolePasswordError(undefined));
});

test('every identity change path syncs console access after its commit', () => {
  const provider = read('src/lib/identity/provider.ts');
  const store = read('src/lib/identity/store.ts');
  const create = provider.slice(provider.indexOf('export async function createUser'), provider.indexOf('export async function updateUser'));
  assert.match(create, /await createIdentityUser[\s\S]*afterIdentityChange\(\{ userId: created\.id, password: input\.password \|\| undefined \}\)/);
  assert.equal(create.split('afterIdentityChange(').length, 2, 'one call, so a generated password is never sent');
  const update = provider.slice(provider.indexOf('export async function updateUser'), provider.indexOf('export async function deleteUser'));
  assert.match(update, /await updateIdentityUser[\s\S]*afterIdentityChange\(\{ userId: id \}\)/);
  const remove = provider.slice(provider.indexOf('export async function deleteUser'), provider.indexOf('export async function setPassword'));
  assert.match(remove, /await deleteIdentityUser[\s\S]*afterIdentityChange\(\{ userId: id \}\)/);
  const password = provider.slice(provider.indexOf('export async function setPassword'), provider.indexOf('export async function listGroups'));
  assert.match(password, /await updateIdentityUser\(id, \{ password \}\);\s*await afterIdentityChange\(\{ userId: id, password \}\)/);
  const claim = store.slice(store.indexOf('export async function claimApplianceOwner'), store.indexOf('export async function getApplianceOwnerId'));
  assert.match(claim, /afterIdentityChange\(\{ userId: owner\.id, password: input\.password \}\)/);
  const ensure = store.slice(store.indexOf('export async function ensureUser'), store.indexOf('async function ensureUserUnderLifecycle'));
  assert.match(ensure, /withIdentityAppLifecycle[\s\S]*afterIdentityChange\(\{ userId: user\.id, password: input\.password \}\)/);
  const instrumentation = read('src/instrumentation.ts');
  assert.ok(instrumentation.indexOf('startConsoleAccessSync()') > instrumentation.indexOf('if (isIdentityService)'),
    'the sync loop runs in the Control Panel, not in the identity service');
});

function resetBox(options: { owner?: string | null; code?: 'ok' | 'refused' | 'down' } = {}) {
  const calls = { codes: [] as string[], passwords: [] as Array<[string, string]>, revoked: [] as string[], logs: [] as string[] };
  const deps: OwnerResetDeps = {
    ownerId: async () => options.owner === undefined ? OWNER : options.owner,
    useCode: async code => {
      calls.codes.push(code);
      if (options.code === 'refused') throw new SpineAPIError('the reset code is not valid', 403);
      if (options.code === 'down') throw new Error('Request timeout');
      return { valid: true };
    },
    setPassword: async (id, password) => { calls.passwords.push([id, password]); },
    revokeSessions: async id => { calls.revoked.push(id); },
    log: message => { calls.logs.push(message); },
  };
  return { deps, calls };
}

test('a valid reset code sets the owner password and ends the owner\'s sessions', async () => {
  const box = resetBox();
  const result = await resetOwnerPassword({ code: ' ABCDE-FGHJK ', password: SECRET, repeatPassword: SECRET }, box.deps);
  assert.equal(result.status, 200);
  assert.deepEqual(box.calls.codes, ['ABCDE-FGHJK']);
  assert.deepEqual(box.calls.passwords, [[OWNER, SECRET]]);
  assert.deepEqual(box.calls.revoked, [OWNER]);
  assert.ok(box.calls.logs.every(line => !line.includes(SECRET)));
});

test('a refused code changes nothing and never says whether a reset is pending', async () => {
  for (const options of [{ code: 'refused' as const }, { owner: null }]) {
    const box = resetBox(options);
    const result = await resetOwnerPassword({ code: 'ABCDE-FGHJK', password: SECRET, repeatPassword: SECRET }, box.deps);
    assert.equal(result.status, 403);
    assert.equal(result.status !== 200 && result.error, 'The code is not valid');
    assert.deepEqual(box.calls.passwords, []);
    assert.deepEqual(box.calls.revoked, []);
  }
  const down = resetBox({ code: 'down' });
  const result = await resetOwnerPassword({ code: 'ABCDE-FGHJK', password: SECRET, repeatPassword: SECRET }, down.deps);
  assert.equal(result.status, 503);
  assert.deepEqual(down.calls.passwords, []);
});

test('a bad new password is refused before the code is spent', async () => {
  for (const body of [
    { code: 'ABCDE-FGHJK', password: 'short', repeatPassword: 'short' },
    { code: 'ABCDE-FGHJK', password: SECRET, repeatPassword: `${SECRET}!` },
    { code: '', password: SECRET, repeatPassword: SECRET },
  ]) {
    const box = resetBox();
    const result = await resetOwnerPassword(body, box.deps);
    assert.notEqual(result.status, 200);
    assert.deepEqual(box.calls.codes, []);
  }
});

test('the reset page and route are public, rate-limited and same-origin', () => {
  const route = read('src/app/api/auth/reset-owner/route.ts');
  const middleware = read('src/middleware.ts');
  assert.match(route, /checkRateLimit\(`owner-reset:\$\{requestIP\(request\)\}`/);
  assert.match(route, /sameOrigin\(request\)/);
  assert.match(route, /useCode: code => spineClient\.useOwnerResetCode\(code\)/);
  assert.match(route, /ownerId: getApplianceOwnerId/);
  assert.match(route, /revokeSessions: revokeAllIdentitySessions/);
  assert.match(read('src/app/settings/api/auth/reset-owner/route.ts'), /export \{ POST \} from '@\/app\/api\/auth\/reset-owner\/route'/);
  for (const publicPath of ['/reset-owner', '/settings/reset-owner', '/settings/api/auth/reset-owner']) {
    assert.ok(middleware.includes(`'${publicPath}'`), publicPath);
  }
  assert.match(read('src/components/auth/owner-reset-form.tsx'), /\/settings\/api\/auth\/reset-owner/);
});
