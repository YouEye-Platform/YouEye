/**
 * YouEye ID sign-in limits (YE-134): per username from any address, per client address across usernames, and no
 * limit on loopback (every client is 127.0.0.1 until Caddy's proxy devices send the real one).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { resetAllRateLimits } from '../src/lib/auth/rate-limit';
import {
  beginSignInAttempt,
  SIGN_IN_ADDRESS_ATTEMPTS,
  SIGN_IN_USERNAME_ATTEMPTS,
  SIGN_IN_WINDOW_SECONDS,
  signInNotCounted,
  signInSucceeded,
  type SignInScope,
} from '../src/lib/identity/sign-in-limit';

/** One sign-in as the route does it: `correct` stands for the password check. */
function signIn(
  username: string,
  address: string | null,
  correct = false,
  scope: SignInScope = 'id-login',
): 'refused' | 'failed' | 'signed-in' {
  const attempt = beginSignInAttempt(username, address, scope);
  if (!attempt.allowed) return 'refused';
  if (!correct) return 'failed';
  signInSucceeded(attempt);
  return 'signed-in';
}

beforeEach(() => {
  resetAllRateLimits();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T10:00:00Z') });
});
afterEach(() => mock.timers.reset());

test('the limits', () => {
  assert.equal(SIGN_IN_USERNAME_ATTEMPTS, 10);
  assert.equal(SIGN_IN_ADDRESS_ATTEMPTS, 30);
  assert.equal(SIGN_IN_WINDOW_SECONDS, 15 * 60);
});

test('10 failures from many addresses lock only that username for the window; the right password works after it', () => {
  for (let i = 0; i < 10; i++) assert.equal(signIn('owner', `192.168.1.${10 + i}`), 'failed');
  assert.equal(signIn('owner', '192.168.1.99', true), 'refused', 'a new address does not get around it');
  assert.equal(signIn('Owner', '192.168.1.99', true), 'refused', 'nor does the case of the username');
  assert.equal(signIn('owner', null, true), 'refused', 'nor loopback');
  assert.equal(signIn('alice', '192.168.1.10', true), 'signed-in', 'other users are not affected');

  mock.timers.tick(SIGN_IN_WINDOW_SECONDS * 1000 - 1);
  assert.equal(signIn('owner', '192.168.1.99', true), 'refused', 'until the window ends');
  mock.timers.tick(2);
  assert.equal(signIn('owner', '192.168.1.99', true), 'signed-in');
});

test('a success clears the username, and refused attempts count against nothing', () => {
  for (let i = 0; i < 9; i++) signIn('owner', '192.168.1.10');
  assert.equal(signIn('owner', '192.168.1.10', true), 'signed-in');
  for (let i = 0; i < 9; i++) assert.equal(signIn('owner', '192.168.1.11'), 'failed', 'the count started over');

  for (let i = 0; i < 10; i++) signIn('bob', '192.168.1.12');
  for (let i = 0; i < 50; i++) assert.equal(signIn('bob', '192.168.1.13'), 'refused');
  // .13's 50 refused tries left it its whole address budget.
  for (let i = 0; i < SIGN_IN_ADDRESS_ATTEMPTS; i++) assert.equal(signIn(`user${i}`, '192.168.1.13'), 'failed');
});

test('one address is stopped after 30 failures across usernames; other addresses are not', () => {
  for (let i = 0; i < SIGN_IN_ADDRESS_ATTEMPTS; i++) assert.equal(signIn(`user${i}`, '203.0.113.7'), 'failed');
  assert.equal(signIn('someone-new', '203.0.113.7', true), 'refused');
  assert.equal(signIn('someone-new', '192.168.1.20', true), 'signed-in');
  // Successes give the address its attempt back: an attacker's own account cannot reset its count.
  resetAllRateLimits();
  for (let i = 0; i < 29; i++) signIn(`user${i}`, '203.0.113.8');
  assert.equal(signIn('mine', '203.0.113.8', true), 'signed-in');
  assert.equal(signIn('user99', '203.0.113.8'), 'failed', 'the 30th failure');
  assert.equal(signIn('user98', '203.0.113.8'), 'refused');
});

test('loopback and unknown are not client addresses, so no address limit locks everyone out', () => {
  for (let i = 0; i < 100; i++) assert.equal(signIn(`user${i}`, null), 'failed');
  assert.equal(signIn('owner', null, true), 'signed-in');
});

test('each scope counts on its own (YE-136): YouEye ID, the Control Panel login, the claim', () => {
  for (let i = 0; i < 10; i++) signIn('owner', '192.168.1.40', false, 'cp-login');
  assert.equal(signIn('owner', '192.168.1.41', true, 'cp-login'), 'refused');
  assert.equal(signIn('owner', '192.168.1.41', true, 'id-login'), 'signed-in');
  assert.equal(signIn('owner', '192.168.1.41', true, 'appliance-claim'), 'signed-in');
});

test('remaining is the smaller of the username\'s and the address\'s; settling twice refunds once', () => {
  for (let i = 0; i < 25; i++) signIn(`user${i}`, '192.168.1.70');
  assert.equal(beginSignInAttempt('fresh', '192.168.1.70').remaining, 4, 'the address has 4 left after this one');
  assert.equal(beginSignInAttempt('fresh2', null).remaining, 9);
  const attempt = beginSignInAttempt('owner', '192.168.1.71');
  signInSucceeded(attempt);
  signInNotCounted(attempt);
  signInSucceeded(attempt);
  assert.equal(beginSignInAttempt('other', '192.168.1.71').remaining, 9, 'the address got exactly one attempt back');
});

test('a form error counts against nothing; a refused attempt is not refunded', () => {
  for (let i = 0; i < 50; i++) {
    const attempt = beginSignInAttempt('owner', '192.168.1.60', 'appliance-claim');
    assert.equal(attempt.allowed, true);
    signInNotCounted(attempt);
  }
  assert.equal(beginSignInAttempt('owner', '192.168.1.60', 'appliance-claim').remaining, 9);
  for (let i = 0; i < 9; i++) signIn('owner', '192.168.1.60', false, 'appliance-claim');
  const refused = beginSignInAttempt('owner', '192.168.1.60', 'appliance-claim');
  assert.equal(refused.allowed, false);
  signInNotCounted(refused);
  signInSucceeded(refused);
  assert.equal(signIn('owner', '192.168.1.61', true, 'appliance-claim'), 'refused', 'nothing a refusal does unlocks it');
});

test('unknown and real usernames are limited the same way, with the same message', () => {
  for (let i = 0; i < 10; i++) signIn('no-such-user', '192.168.1.30');
  assert.equal(signIn('no-such-user', '192.168.1.31'), 'refused');
  const root = process.env.CONTROL_PANEL_ROOT ?? process.cwd();
  const route = readFileSync(join(root, 'src/app/identity/login/route.ts'), 'utf8');
  assert.match(route, /beginSignInAttempt\(username, await requestClientAddress\(request\.headers\)\)/);
  assert.match(route, /if \(!attempt\.allowed\) \{\n\s+return html\(returnTo, 'Too many sign-in attempts\. Try again later\.'\);/);
  assert.match(route, /if \(!user\) \{\n\s+return html\(returnTo, 'Invalid username or password\.'\);\n\s+\}\n\s+signInSucceeded\(attempt\);/);
  assert.doesNotMatch(route, /id-login:/, 'the old per-address-and-username key is gone');
  const store = readFileSync(join(root, 'src/lib/identity/store.ts'), 'utf8');
  assert.match(store, /if \(!user\) \{\n\s+verifyPassword\(password, UNKNOWN_USER_HASH\);/, 'an unknown user costs the same scrypt');
});
