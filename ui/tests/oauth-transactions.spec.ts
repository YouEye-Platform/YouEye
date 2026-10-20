import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import { excessOAuthTransactions, oauthTransactionName, oauthTransactionValue, readOAuthTransaction, safeOAuthReturn } from '../../shared/oauth-transaction';

test('parallel iframe and CP logins retain independent state and return destinations', () => {
  const attempts = [
    { client: 'cp' as const, state: 'a'.repeat(64), path: '/settings?tab=people' },
    { client: 'ui' as const, state: 'a'.repeat(64), path: '/embed/drawer' },
    { client: 'ui' as const, state: 'b'.repeat(64), path: '/embed/launcher?query=a%26b' },
    { client: 'ui' as const, state: 'c'.repeat(64), path: '/embed/notifications' },
  ];
  const response = NextResponse.next();
  for (const a of attempts) response.cookies.set(oauthTransactionName(a.client, a.state)!, oauthTransactionValue(a.state, a.path));
  const request = new NextRequest('https://example.test/api/auth/callback', {
    headers: { cookie: response.cookies.getAll().map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ') },
  });
  for (const a of attempts.toReversed()) {
    const name = oauthTransactionName(a.client, a.state)!;
    assert.equal(readOAuthTransaction(request.cookies.get(name)?.value, a.state), a.path);
    response.cookies.delete(name);
  }
});

test('missing, malformed, mismatched and cross-client attempts cannot authenticate', () => {
  assert.equal(oauthTransactionName('ui', '../../cookie'), null);
  assert.equal(readOAuthTransaction(undefined, 'a'.repeat(64)), null);
  assert.equal(readOAuthTransaction('broken-json', 'a'.repeat(64)), null);
  assert.equal(readOAuthTransaction(oauthTransactionValue('a'.repeat(64), '/'), 'b'.repeat(64)), null);
  assert.notEqual(oauthTransactionName('cp', 'a'.repeat(64)), oauthTransactionName('ui', 'a'.repeat(64)));
});

test('return destinations reject open redirects and preserve encoded local query bytes', () => {
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/%5cevil.test', '/\n/evil.test', '/%00evil', '/%']) {
    assert.equal(safeOAuthReturn(path, '/settings'), '/settings', path);
  }
  assert.equal(safeOAuthReturn('/embed/drawer?q=a%26b&next=%2Fsettings'), '/embed/drawer?q=a%26b&next=%2Fsettings');
});

test('attempt cookie retention is bounded and does not evict the other client', () => {
  const names = Array.from({length: 10}, (_, i) => oauthTransactionName('ui', i.toString(16).padStart(64, '0'))!);
  assert.deepEqual(excessOAuthTransactions('ui', [...names, oauthTransactionName('cp', 'd'.repeat(64))!, 'unrelated']), names.slice(7));
});
