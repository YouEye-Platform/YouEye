/**
 * Sign-in limits (YE-134, YE-136, YE-149): a lock per (username, source address), a limit per source address, and a
 * per-username slow-down that never locks, so nobody who can reach a sign-in form can keep a user out.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import {
  beginSignInAttempt,
  SHARED_SOURCE,
  SIGN_IN_ADDRESS_ATTEMPTS,
  SIGN_IN_FREE_FAILURES,
  SIGN_IN_MAX_DELAY_SECONDS,
  SIGN_IN_PAIR_ATTEMPTS,
  SIGN_IN_STORE_LIMIT,
  SIGN_IN_WINDOW_SECONDS,
  SIGN_IN_PREFIX48_ATTEMPTS,
  SIGN_IN_PREFIX56_ATTEMPTS,
  signInDelaySeconds,
  signInLimitEntries,
  signInPrefixes,
  signInNotCounted,
  signInRetryAfterSeconds,
  signInSourceOf,
  signInSucceeded,
  resetSignInLimits,
  type SignInAttempt,
  type SignInScope,
} from '../src/lib/identity/sign-in-limit';

type Outcome = 'locked' | 'wait' | 'failed' | 'signed-in';

/** One sign-in as the routes do it: `correct` stands for the password check. */
function signIn(username: string, address: string | null, correct = false, scope: SignInScope = 'id-login'): Outcome {
  const attempt = beginSignInAttempt(username, address, scope);
  if (!attempt.allowed) return attempt.refusal!;
  if (!correct) return 'failed';
  signInSucceeded(attempt);
  return 'signed-in';
}

/** Wait out a refused attempt's Retry-After. */
function waitFor(attempt: SignInAttempt): void {
  mock.timers.tick(signInRetryAfterSeconds(attempt) * 1000);
}

/** Fail from `address` until the attempt is refused or `times` failures are in; waits are sat out. */
function failPatiently(username: string, address: string | null, times: number, scope: SignInScope = 'id-login'): void {
  for (let done = 0; done < times;) {
    const attempt = beginSignInAttempt(username, address, scope);
    if (attempt.allowed) done++;
    else if (attempt.refusal === 'wait') waitFor(attempt);
    else throw new Error(`locked after ${done} failures`);
  }
}

const root = process.env.CONTROL_PANEL_ROOT ?? process.cwd();

beforeEach(() => {
  resetSignInLimits();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T10:00:00Z') });
});
afterEach(() => mock.timers.reset());

test('the limits', () => {
  assert.equal(SIGN_IN_PAIR_ATTEMPTS, 10);
  assert.equal(SIGN_IN_ADDRESS_ATTEMPTS, 30);
  assert.equal(SIGN_IN_WINDOW_SECONDS, 15 * 60);
  assert.equal(SIGN_IN_FREE_FAILURES, 5);
  assert.equal(SIGN_IN_MAX_DELAY_SECONDS, 60);
  assert.deepEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 50].map(signInDelaySeconds), [0, 0, 1, 2, 4, 8, 16, 32, 60, 60]);
});

test('10 failures from address A do not stop the owner signing in from address B', () => {
  failPatiently('owner', '203.0.113.10', SIGN_IN_PAIR_ATTEMPTS);
  const locked = beginSignInAttempt('owner', '203.0.113.10');
  assert.equal(locked.refusal, 'locked', 'A is locked for the owner');
  assert.equal(signInRetryAfterSeconds(locked) <= SIGN_IN_WINDOW_SECONDS, true);
  assert.equal(signIn('owner', '192.168.1.20', true), 'signed-in', 'B is checked at once and the right password works');
  assert.equal(signIn('Owner ', '203.0.113.10', true), 'locked', 'the case or spaces of the username do not get around it');
  assert.equal(signIn('alice', '203.0.113.10', true), 'signed-in', 'A can still sign in as another user');

  mock.timers.tick(SIGN_IN_WINDOW_SECONDS * 1000);
  assert.equal(signIn('owner', '203.0.113.10', true), 'signed-in', 'the lock ends with the window');
});

test('failures from many addresses only slow the username down, never lock it; the right password works', () => {
  // 100 failures from 50 addresses, each waiting out its slow-down.
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 50; i++) failPatiently('owner', `198.51.100.${i}`, 1);
  }
  // A fresh address is checked at once.
  assert.equal(signIn('owner', '192.168.1.30', true), 'signed-in');
  // A source that has just failed waits at most the cap, then the right password works.
  assert.equal(signIn('owner', '192.168.1.31'), 'failed');
  const wait = beginSignInAttempt('owner', '192.168.1.31');
  assert.equal(wait.refusal, 'wait');
  assert.equal(signInRetryAfterSeconds(wait), SIGN_IN_MAX_DELAY_SECONDS);
  assert.equal(wait.remaining, undefined);
  waitFor(wait);
  assert.equal(signIn('owner', '192.168.1.31', true), 'signed-in');
});

test('the wait grows with the username\'s failures from all sources, and only for a source that failed', () => {
  for (let i = 0; i < 4; i++) assert.equal(signIn('owner', `198.51.100.${i}`), 'failed');
  assert.equal(signIn('owner', '198.51.100.0'), 'failed', 'four failures cost nothing: no wait');
  // That was the fifth: .0 now waits 1 s; another source that failed before does not.
  assert.equal(signIn('owner', '198.51.100.0'), 'wait');
  assert.equal(signIn('owner', '198.51.100.1'), 'failed', 'sixth: .1 waits 2 s');
  const attempt = beginSignInAttempt('owner', '198.51.100.1');
  assert.equal(signInRetryAfterSeconds(attempt), 2);
  mock.timers.tick(1999);
  assert.equal(signIn('owner', '198.51.100.1'), 'wait');
  mock.timers.tick(1);
  assert.equal(signIn('owner', '198.51.100.1', true), 'signed-in');
});

test('parallel attempts from one source pass the slow-down once', () => {
  failPatiently('owner', '198.51.100.7', SIGN_IN_FREE_FAILURES);
  mock.timers.tick(SIGN_IN_MAX_DELAY_SECONDS * 1000);
  // Three requests at once: the first is checked, the others wait for it.
  const attempts = [0, 1, 2].map(() => beginSignInAttempt('owner', '198.51.100.7'));
  assert.deepEqual(attempts.map((attempt) => attempt.allowed), [true, false, false]);
  assert.deepEqual(attempts.slice(1).map((attempt) => attempt.refusal), ['wait', 'wait']);
});

test('a success clears its own pair but not the username\'s slow-down for the others', () => {
  failPatiently('owner', '198.51.100.8', 8); // n = 8
  assert.equal(signIn('owner', '192.168.1.40', true), 'signed-in', 'the owner, from home');
  // The ninth failure (from anyone) gets the ninth failure's wait: the success did not start the count over.
  assert.equal(signIn('owner', '198.51.100.9'), 'failed');
  assert.equal(signInRetryAfterSeconds(beginSignInAttempt('owner', '198.51.100.9')), signInDelaySeconds(9));
  // The source that signed in has no wait and a fresh count of its own.
  assert.equal(signIn('owner', '192.168.1.40'), 'failed');
  assert.equal(beginSignInAttempt('alice', '192.168.1.40').remaining, SIGN_IN_PAIR_ATTEMPTS - 1);
});

test('a form error counts against nothing and leaves no wait; a refused attempt is not refunded', () => {
  failPatiently('owner', '192.168.1.60', SIGN_IN_FREE_FAILURES - 1, 'appliance-claim');
  for (let i = 0; i < 50; i++) {
    const attempt = beginSignInAttempt('owner', '192.168.1.60', 'appliance-claim');
    assert.equal(attempt.allowed, true);
    signInNotCounted(attempt);
    signInNotCounted(attempt);
  }
  assert.equal(beginSignInAttempt('owner', '192.168.1.60', 'appliance-claim').remaining, SIGN_IN_PAIR_ATTEMPTS - 5);
  // That was the fifth failure: now it waits, and nothing a refusal does lifts the wait.
  const refused = beginSignInAttempt('owner', '192.168.1.60', 'appliance-claim');
  assert.equal(refused.refusal, 'wait');
  signInNotCounted(refused);
  signInSucceeded(refused);
  assert.equal(signIn('owner', '192.168.1.60', true, 'appliance-claim'), 'wait');
});

test('one address is stopped after 30 failures across usernames; others are not; its own success refunds one', () => {
  for (let i = 0; i < SIGN_IN_ADDRESS_ATTEMPTS; i++) assert.equal(signIn(`user${i}`, '203.0.113.7'), 'failed');
  assert.equal(signIn('someone-new', '203.0.113.7', true), 'locked');
  assert.equal(signIn('someone-new', '192.168.1.20', true), 'signed-in');
  resetSignInLimits();
  for (let i = 0; i < 29; i++) signIn(`user${i}`, '203.0.113.8');
  assert.equal(signIn('mine', '203.0.113.8', true), 'signed-in');
  assert.equal(signIn('user99', '203.0.113.8'), 'failed', 'the 30th failure');
  assert.equal(signIn('user98', '203.0.113.8'), 'locked');
});

test('the shared source (loopback, the shared NAT address, unknown) is slowed down, never locked', () => {
  // 40 failures for the owner from the shared source, each waiting out its slow-down: never a lock.
  failPatiently('owner', null, 40);
  const wait = beginSignInAttempt('owner', null);
  assert.equal(wait.refusal, 'wait');
  assert.equal(signInRetryAfterSeconds(wait) <= SIGN_IN_MAX_DELAY_SECONDS, true);
  waitFor(wait);
  assert.equal(signIn('owner', null, true), 'signed-in', 'the right password works after the wait');
  // No address limit there: 100 usernames, one failure each.
  for (let i = 0; i < 100; i++) assert.equal(signIn(`local-${i}`, null), 'failed');
  assert.equal(beginSignInAttempt('fresh', null).remaining, undefined);
  assert.equal(signInSourceOf(null), SHARED_SOURCE);
});

test('each scope counts on its own: YouEye ID, the Control Panel login, the claim, the owner reset', () => {
  failPatiently('owner', '192.168.1.40', SIGN_IN_PAIR_ATTEMPTS, 'cp-login');
  assert.equal(signIn('owner', '192.168.1.40', true, 'cp-login'), 'locked');
  for (const scope of ['id-login', 'appliance-claim', 'owner-reset'] as const) {
    assert.equal(signIn('owner', '192.168.1.40', true, scope), 'signed-in', scope);
  }
});

test('IPv6 counts by /64: two addresses in one /64 are one source; IPv4 stays per address', () => {
  assert.equal(signInSourceOf('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(signInSourceOf('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(signInSourceOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(signInSourceOf('::1.2.3.4'), '0:0:0:0::/64');
  assert.equal(signInSourceOf('192.168.1.5'), '192.168.1.5');
  assert.notEqual(signInSourceOf('192.168.1.5'), signInSourceOf('192.168.1.6'));

  // The pair lock: 5 failures from each of two addresses in one /64 lock both.
  failPatiently('owner', '2001:db8:1:2::a', 5);
  failPatiently('owner', '2001:db8:1:2::b', 5);
  assert.equal(signIn('owner', '2001:db8:1:2::c', true), 'locked');
  assert.equal(signIn('owner', '2001:db8:1:3::c', true), 'signed-in', 'the next /64 is another source');
  // The slow-down: a new address in the same /64 is not a fresh source.
  resetSignInLimits();
  failPatiently('alice', '2001:db8:9::1', SIGN_IN_FREE_FAILURES);
  assert.equal(signIn('alice', '2001:db8:9::2', true), 'wait');
  // The address limit: 30 usernames from 30 addresses in one /64.
  resetSignInLimits();
  for (let i = 0; i < SIGN_IN_ADDRESS_ATTEMPTS; i++) signIn(`user${i}`, `2001:db8:5:5::${(i + 1).toString(16)}`);
  assert.equal(signIn('someone', '2001:db8:5:5::ffff', true), 'locked');
});

test('IPv6 prefixes: a /56 and a /48 have failure limits of their own; IPv4 has none wider than the address', () => {
  assert.equal(SIGN_IN_PREFIX56_ATTEMPTS, 100);
  assert.equal(SIGN_IN_PREFIX48_ATTEMPTS, 300);
  assert.deepEqual(signInPrefixes('2001:db8:1:2a3c::1'), [
    { prefix: '2001:db8:1:2a00::/56', limit: 100 },
    { prefix: '2001:db8:1::/48', limit: 300 },
  ]);
  assert.deepEqual(signInPrefixes('2001:db8::1').map((p) => p.prefix), ['2001:db8:0:0::/56', '2001:db8:0::/48']);
  assert.deepEqual(signInPrefixes('192.168.1.5'), []);
  assert.deepEqual(signInPrefixes(null), []);
});

test('65k /64s in one /48 get at most the /48 limit of checks; the owner from another prefix is checked at once', () => {
  let checked = 0;
  for (let i = 0; i < 65_536; i++) {
    if (beginSignInAttempt('owner', `2001:db8:7:${i.toString(16)}::1`).allowed) checked++;
  }
  assert.ok(checked <= SIGN_IN_PREFIX48_ATTEMPTS, `${checked} checks`);
  assert.ok(checked >= SIGN_IN_PREFIX56_ATTEMPTS, `${checked} checks`);
  // Past the limit the prefix waits, for every username, real or not, and with a Retry-After.
  for (const username of ['owner', 'alice', 'no-such-user']) {
    const refused = beginSignInAttempt(username, '2001:db8:7:ffff::2');
    assert.equal(refused.refusal, 'locked', username);
    assert.ok(signInRetryAfterSeconds(refused) > 0);
  }
  // Another /48, IPv4 and the shared source are not touched; the owner's right password works at once.
  assert.equal(signIn('owner', '2001:db8:8:1::1', true), 'signed-in');
  assert.equal(signIn('owner', '192.0.2.40', true), 'signed-in');
  assert.equal(signIn('alice', null, true), 'signed-in');
});

test('a /56 stops at its own limit; two /56s in one /48 share the /48 count', () => {
  // 100 failures from each of three /56s in 2001:db8:9::/48, spread over /64s and usernames (no pair or /64 limit).
  const fail = (sixtyFour: number) => {
    for (let i = 0; i < 25; i++) assert.equal(signIn(`spray-${sixtyFour}-${i}`, `2001:db8:9:${sixtyFour.toString(16)}::1`), 'failed');
  };
  for (const s56 of [0x0100, 0x0200]) for (let k = 0; k < 4; k++) fail(s56 + k);
  // The /56 2001:db8:9:100::/56 is stopped; its neighbour 2001:db8:9:300::/56 is not.
  assert.equal(signIn('fresh', '2001:db8:9:1ff::1'), 'locked');
  assert.equal(signIn('fresh', '2001:db8:9:300::1'), 'failed');
  // That was failure 201 of the /48; 99 more from the third /56 (fresh /64s and usernames), and the /48 is full.
  for (let i = 0; i < 99; i++) signIn(`more-${i}`, `2001:db8:9:3${(1 + (i >> 4)).toString(16)}${(i & 15).toString(16)}::1`);
  assert.equal(signIn('fresh', '2001:db8:9:400::1'), 'locked', 'a fourth /56 shares the /48 count');
  assert.equal(signIn('fresh', '2001:db8:a:400::1'), 'failed', 'the next /48 is another network');
});

test('no existence oracle: an unknown username is counted, slowed, refused and timed exactly like a real one', () => {
  const trace = (username: string) => {
    resetSignInLimits();
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T10:00:00Z') });
    const steps: unknown[] = [];
    for (let i = 0; i < 14; i++) {
      const attempt = beginSignInAttempt(username, i < 12 ? '203.0.113.50' : null);
      steps.push([attempt.allowed, attempt.refusal, attempt.retryAt && signInRetryAfterSeconds(attempt), attempt.remaining]);
      if (!attempt.allowed && attempt.refusal === 'wait') waitFor(attempt);
    }
    return steps;
  };
  assert.deepEqual(trace('no-such-user'), trace('owner'));

  // The routes decide before the password check, and answer with one message for both.
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const id = read('src/app/identity/login/route.ts');
  assert.match(id, /if \(!username \|\| !password\) return html\(returnTo, 'Invalid username or password\.'\);\n\s+\/\/ Per \(username/,
    'an empty form counts nothing and is answered like a wrong password');
  assert.ok(id.indexOf('beginSignInAttempt(') < id.indexOf('verifyUser('), 'YouEye ID refuses before the check');
  assert.match(id, /if \(!user\) \{\n\s+return html\(returnTo, 'Invalid username or password\.'\);\n\s+\}\n\s+signInSucceeded\(attempt\);/);
  const cp = read('src/app/api/auth/login/route.ts');
  assert.ok(cp.indexOf('beginSignInAttempt(') < cp.indexOf('authenticatePAM('), 'the CP login refuses before PAM');
  const claim = read('src/app/api/appliance/claim/route.ts');
  assert.ok(claim.indexOf('beginSignInAttempt(') < claim.indexOf('verifyApplianceOwner('), 'the claim refuses before the check');
  for (const route of [id, cp, claim]) assert.doesNotMatch(route, /getUserByUsername|userExists/);
  const store = read('src/lib/identity/store.ts');
  assert.match(store, /if \(!user\) \{\n\s+verifyPassword\(password, UNKNOWN_USER_HASH\);/, 'an unknown user costs the same scrypt');
});

test('a flood of random usernames cannot lift a live lock, an address limit or a wait', () => {
  failPatiently('owner', '203.0.113.60', SIGN_IN_PAIR_ATTEMPTS); // (owner, .60) locked
  for (let i = 0; i < SIGN_IN_ADDRESS_ATTEMPTS; i++) signIn(`spray${i}`, '203.0.113.61'); // .61 stopped
  for (let i = 0; i < 9; i++) signIn('victim', `198.51.100.${70 + i}`);
  signIn('victim', '203.0.113.62'); // the tenth failure: .62 waits 32 s on victim
  const waitBefore = signInRetryAfterSeconds(beginSignInAttempt('victim', '203.0.113.62'));
  assert.equal(waitBefore, 32);

  // Far more new keys than the store holds, from the shared source (no address limit to stop them).
  for (let i = 0; i < SIGN_IN_STORE_LIMIT; i++) signIn(`flood-${i}`, null);
  assert.ok(signInLimitEntries() <= SIGN_IN_STORE_LIMIT);

  assert.equal(signIn('owner', '203.0.113.60', true), 'locked');
  assert.equal(signIn('someone', '203.0.113.61', true), 'locked');
  assert.equal(signInRetryAfterSeconds(beginSignInAttempt('victim', '203.0.113.62')), waitBefore);
  // The flood took room only from entries with no effect: a new user still signs in.
  assert.equal(signIn('alice', '192.168.1.5', true), 'signed-in');
});

test('a store full of live effects keeps them all, and lets no source guess unlimited (fail closed)', () => {
  // Every source that fails on the victim waits, an active entry each, until the store holds nothing else.
  for (let i = 0; i < SIGN_IN_STORE_LIMIT * 1.2; i++) signIn('victim', `10.${1 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`);
  const full = signInLimitEntries();
  assert.ok(full <= SIGN_IN_STORE_LIMIT && full > SIGN_IN_STORE_LIMIT * 0.99, String(full));
  // Every one that failed after the free failures still waits: none was dropped to make room.
  assert.equal(signIn('victim', '10.1.0.10'), 'wait');
  assert.equal(signIn('victim', '10.1.0.200'), 'wait');
  // A new address, and the shared source, back to back: at most the address limit, and one shared try per wait.
  const burst = (address: string | null) => Array.from({ length: 200 }, () => beginSignInAttempt('victim', address))
    .filter((attempt) => attempt.allowed).length;
  assert.ok(burst('192.0.2.99') <= SIGN_IN_ADDRESS_ATTEMPTS);
  assert.ok(burst('2001:db8:77::1') <= SIGN_IN_ADDRESS_ATTEMPTS);
  assert.ok(burst(null) <= 1);
  assert.ok(signInLimitEntries() <= SIGN_IN_STORE_LIMIT);
  // When the waits run out, their entries make room again, and a new user signs in.
  mock.timers.tick(SIGN_IN_WINDOW_SECONDS * 1000 + 1);
  assert.equal(signIn('later', '192.0.2.10', true), 'signed-in');
  assert.ok(signInLimitEntries() < SIGN_IN_STORE_LIMIT);
});

test('usernames cannot take the reserve: a flood of them leaves new addresses their limit', () => {
  // Random usernames from many addresses, one failure each, never sitting out anything: usernames and pairs stop
  // at the store's limit less its reserve.
  for (let i = 0; i < SIGN_IN_STORE_LIMIT; i++) signIn(`flood-${i}`, `10.${1 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`);
  // The victim, from one new address after another: each new address still gets its own count and limit.
  for (let i = 0; i < 40; i++) assert.equal(beginSignInAttempt(`spray-${i}`, '192.0.2.50').allowed, i < SIGN_IN_ADDRESS_ATTEMPTS, `try ${i + 1}`);
});

test('a form error does not lift the wait a parallel attempt from the same source set', () => {
  failPatiently('owner', '192.168.1.80', SIGN_IN_FREE_FAILURES - 1, 'appliance-claim');
  const first = beginSignInAttempt('owner', '192.168.1.80', 'appliance-claim'); // the fifth: sets a 1 s wait
  assert.equal(first.allowed, true);
  const before = beginSignInAttempt('owner', '192.168.1.80', 'appliance-claim');
  assert.equal(before.refusal, 'wait');
  // An earlier attempt from that source (no wait of its own) settles as a form error: the wait stays.
  resetSignInLimits();
  failPatiently('owner', '192.168.1.81', SIGN_IN_FREE_FAILURES - 2, 'appliance-claim');
  const early = beginSignInAttempt('owner', '192.168.1.81', 'appliance-claim'); // fourth, no wait
  const late = beginSignInAttempt('owner', '192.168.1.81', 'appliance-claim'); // fifth, sets the wait
  assert.equal(early.allowed && late.allowed, true);
  signInNotCounted(early);
  assert.equal(beginSignInAttempt('owner', '192.168.1.81', 'appliance-claim').refusal, 'wait');
});
