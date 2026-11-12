import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateIdentityUsername } from '../src/lib/identity/username-policy';

test('usernames start with a lowercase letter and hold 3-32 of [a-z0-9._-]', () => {
  for (const ok of ['bob', 'a.b_c-d', 'a1234567890123456789012345678901']) assert.equal(validateIdentityUsername(ok), null, ok);
  for (const bad of ['', 'ab', '1bob', 'Bob', 'bo b', ' bob', 'bob@x', 'a12345678901234567890123456789012', undefined, 7]) {
    assert.match(validateIdentityUsername(bad) ?? '', /3-32 characters/, String(bad));
  }
});

test('every account-creating store function enforces the rule before writing', () => {
  const store = readFileSync('src/lib/identity/store.ts', 'utf8');
  for (const fn of ['createIdentityUserUnderLifecycle', 'claimApplianceOwner']) {
    const body = store.slice(store.indexOf(`function ${fn}(`));
    const check = body.indexOf('requireIdentityUsername(input.username)');
    assert.ok(check > 0 && check < body.indexOf('INSERT INTO identity_users'), fn);
  }
});
