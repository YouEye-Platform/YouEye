// Run: node --import tsx --test tests/pam-username-bound.spec.ts
// YE-169: a sign-in username is the characters accepted before, at most 32, never with a leading `-`. A name outside
// the rule never reaches Spine and is counted against nothing.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { NextRequest } from 'next/server';

import { SpineClient } from '../src/lib/spine/client';
import { authenticatePAM, isValidPAMUsername } from '../src/lib/auth/pam';
import { beginSignInAttempt, resetSignInLimits } from '../src/lib/identity/sign-in-limit';

const GOOD = ['owner', 'Owner_1', 'a', '_svc', 'tester2', 'a-b', 'x'.repeat(32)];
const BAD = ['x'.repeat(33), '-v', '--help', '-', 'a b', '', 'ad.min', 'é', 'a\n', 'owner;id'];

beforeEach(() => resetSignInLimits());
afterEach(() => mock.restoreAll());

test('the username rule keeps today\'s names and bounds the rest', () => {
  for (const name of GOOD) assert.equal(isValidPAMUsername(name), true, name);
  for (const name of BAD) assert.equal(isValidPAMUsername(name), false, JSON.stringify(name));
  assert.equal(isValidPAMUsername(42), false);
});

test('authenticatePAM never asks Spine about a name outside the rule', async () => {
  const verify = mock.method(SpineClient.prototype, 'verifyAuth', async () => ({ authenticated: true, username: 'x', groups: [] }));
  for (const name of BAD.filter(Boolean)) {
    const result = await authenticatePAM(name, 'secret');
    assert.equal(result.success, false, JSON.stringify(name));
  }
  assert.equal(verify.mock.callCount(), 0);
  assert.equal((await authenticatePAM('x'.repeat(32), 'secret')).success, true);
  assert.equal(verify.mock.callCount(), 1);
});

async function login(username: unknown, password: unknown) {
  const { POST } = await import('../src/app/api/auth/login/route');
  return POST(new NextRequest('http://127.0.0.1:3000/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  }));
}

test('/api/auth/login answers a name outside the rule with 400, without Spine and without counting', async () => {
  const verify = mock.method(SpineClient.prototype, 'verifyAuth', async () => ({ authenticated: false }));
  for (const name of ['x'.repeat(33), '-v', '--help', 'a b', 'y'.repeat(100_000)]) {
    for (let i = 0; i < 8; i++) {
      const response = await login(name, 'secret');
      assert.equal(response.status, 400, name.slice(0, 40));
      assert.equal((await response.json()).error, 'Invalid username format');
    }
  }
  assert.equal(verify.mock.callCount(), 0);
  // Nothing was counted: neither the names nor the client address are limited now.
  assert.equal(beginSignInAttempt('-v', null, 'cp-login').allowed, true);
  assert.equal(beginSignInAttempt('owner', null, 'cp-login').allowed, true);
  // An empty name is still "required".
  assert.equal((await (await login('', 'secret')).json()).error, 'Username and password are required');
});
