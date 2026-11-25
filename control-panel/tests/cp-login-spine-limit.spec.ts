// Run: node --import tsx --test tests/cp-login-spine-limit.spec.ts
// YE-149/YE-164: when Spine's own PAM limit refuses to check a password (HTTP 429), the Control Panel's login says
// when to try again (429 + Retry-After) instead of "Invalid credentials", and counts it against nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createTranslator } from 'next-intl';
import { NextRequest } from 'next/server';

import { SpineAPIError, SpineClient } from '../src/lib/spine/client';
import { authenticatePAM, spineRetryAfterSeconds } from '../src/lib/auth/pam';
import { beginSignInAttempt, resetSignInLimits } from '../src/lib/identity/sign-in-limit';

const NOW = Date.parse('2026-11-24T01:00:00Z');
const spine429 = (headers: Record<string, string> = {}) => new SpineAPIError(
  'too many authentication attempts, please wait 5 minutes', 429, undefined,
  { error: 'too many authentication attempts, please wait 5 minutes' }, headers);
// Seb-3's Spine fix: a full PAM queue answers 503 with Retry-After.
const spine503 = (headers: Record<string, string> = {}) => new SpineAPIError(
  'authentication busy', 503, undefined, { error: 'authentication busy' }, headers);

beforeEach(() => resetSignInLimits());
afterEach(() => mock.restoreAll());

test('Spine\'s Retry-After wins, then its reset time, then the minutes in its message', () => {
  assert.equal(spineRetryAfterSeconds(spine503({ 'retry-after': '7' }), NOW), 7);
  assert.equal(spineRetryAfterSeconds(spine429({ 'retry-after': '12', 'x-ratelimit-reset': String(NOW / 1000 + 170) }), NOW), 12);
  assert.equal(spineRetryAfterSeconds(spine503(), NOW), 300);
  assert.equal(spineRetryAfterSeconds(spine429({ 'x-ratelimit-reset': String(NOW / 1000 + 170) }), NOW), 170);
  assert.equal(spineRetryAfterSeconds(spine429(), NOW), 300);
  assert.equal(spineRetryAfterSeconds(new SpineAPIError('slow down', 429), NOW), 300);
  assert.equal(spineRetryAfterSeconds(spine429({ 'x-ratelimit-reset': String(NOW / 1000 - 5) }), NOW), 1);
  assert.equal(spineRetryAfterSeconds(spine429({ 'x-ratelimit-reset': String(NOW / 1000 + 99_999) }), NOW), 3600);
});

test('authenticatePAM reports Spine\'s 429 and 503 as rate limited, not as a wrong password', async () => {
  for (const [error, seconds] of [[spine429(), 300], [spine503({ 'retry-after': '9' }), 9]] as const) {
    mock.method(SpineClient.prototype, 'verifyAuth', async () => { throw error; });
    const result = await authenticatePAM('admin', 'right-or-wrong');
    assert.equal(result.success, false);
    assert.equal(result.rateLimited, true, String(error.statusCode));
    assert.equal(result.retryAfter, seconds);
    mock.restoreAll();
  }
  // Another Spine error is not a refusal to check: it stays an error, never "rate limited".
  mock.method(SpineClient.prototype, 'verifyAuth', async () => { throw new SpineAPIError('boom', 500); });
  mock.method(SpineClient.prototype, 'isAvailable', async () => true);
  assert.equal((await authenticatePAM('admin', 'x')).rateLimited, undefined);
});

async function login(username: string, password: string) {
  const { POST } = await import('../src/app/api/auth/login/route');
  return POST(new NextRequest('http://127.0.0.1:3000/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  }));
}

test('/api/auth/login answers Spine\'s 429 with 429, Retry-After and "try again", and counts nothing', async () => {
  mock.method(SpineClient.prototype, 'verifyAuth', async () => {
    throw spine429({ 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 240) });
  });
  for (let i = 0; i < 12; i++) {
    const response = await login('admin', 'whatever');
    assert.equal(response.status, 429, `try ${i + 1}`);
    const retryAfter = Number(response.headers.get('retry-after'));
    assert.ok(retryAfter >= 239 && retryAfter <= 240, String(retryAfter));
    const body = await response.json();
    assert.match(body.error, /^Too many login attempts\. Please try again in \d+ seconds\.$/);
    assert.doesNotMatch(JSON.stringify(body), /Invalid credentials|remaining/);
  }
  // Twelve refusals from Spine left the Control Panel's own counts untouched: the next try is checked at once,
  // with all its attempts left (no client address here: the shared source, with no slow-down started).
  const next = beginSignInAttempt('admin', null, 'cp-login');
  assert.equal(next.allowed, true);
});

test('/api/auth/login answers Spine\'s 503 (PAM queue full) with 429 and Spine\'s Retry-After, never 401', async () => {
  mock.method(SpineClient.prototype, 'verifyAuth', async () => { throw spine503({ 'retry-after': '15' }); });
  const response = await login('admin', 'right-password');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '15');
  const body = await response.json();
  assert.equal(body.error, 'Too many login attempts. Please try again in 15 seconds.');
  assert.equal(body.retryAfter, 15);
  assert.equal(beginSignInAttempt('admin', null, 'cp-login').allowed, true, 'counted against nothing');
});

test('the login form shows a 429 as a translated "try again in N seconds" in every language', () => {
  const form = readFileSync(new URL('../src/components/auth/login-form.tsx', import.meta.url), 'utf8');
  assert.match(form, /if \(response\.status === 429 && Number\.isFinite\(retryAfter\) && retryAfter > 0\) \{\n\s+setError\(translateInterface\("m1a403ef0db2d", \{seconds: Math\.ceil\(retryAfter\)\}\)\);/);
  const expected: Record<string, [string, string]> = {
    en: ['Too many attempts. Try again in 1 second.', 'Too many attempts. Try again in 240 seconds.'],
    de: ['Zu viele Versuche. Versuchen Sie es in 1 Sekunde erneut.', 'Zu viele Versuche. Versuchen Sie es in 240 Sekunden erneut.'],
    es: ['Demasiados intentos. Inténtalo de nuevo en 1 segundo.', 'Demasiados intentos. Inténtalo de nuevo en 240 segundos.'],
    fr: ['Trop de tentatives. Réessayez dans 1 seconde.', 'Trop de tentatives. Réessayez dans 240 secondes.'],
    ru: ['Слишком много попыток. Повторите через 1 секунду.', 'Слишком много попыток. Повторите через 240 секунд.'],
  };
  for (const [locale, [one, many]] of Object.entries(expected)) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
    const t = createTranslator({ locale, messages, namespace: 'interface' });
    assert.equal(t('m1a403ef0db2d', { seconds: 1 }), one);
    assert.equal(t('m1a403ef0db2d', { seconds: 240 }), many);
  }
});

test('a wrong password checked by Spine is still 401 "Invalid credentials"', async () => {
  mock.method(SpineClient.prototype, 'verifyAuth', async () => ({ authenticated: false, username: 'admin', groups: [] }));
  const response = await login('admin', 'wrong');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Invalid credentials');
});
