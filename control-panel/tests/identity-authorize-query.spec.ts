import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { identitySearchParams, ORIGINAL_IDENTITY_QUERY_HEADER, originalIdentityQuery } from '../src/lib/identity/authorize-query';

test('identity query preserves loopback URI bytes lost by NextURL normalization', () => {
  const redirectUri = 'http://127.0.0.1:49152/callback';
  const query = new URLSearchParams({ client_id: 'native-client', redirect_uri: redirectUri }).toString();
  const incoming = new NextRequest(`https://auth.example.test/application/o/authorize?${query}`);
  assert.equal(incoming.nextUrl.searchParams.get('redirect_uri'), 'http://localhost:49152/callback');
  assert.equal(new URLSearchParams(originalIdentityQuery(incoming)).get('redirect_uri'), redirectUri);

  const headers = new Headers({ [ORIGINAL_IDENTITY_QUERY_HEADER]: originalIdentityQuery(incoming) });
  const routeRequest = new NextRequest(incoming.url, { headers });
  assert.equal(identitySearchParams(routeRequest).get('redirect_uri'), redirectUri);
});

test('identity query requires a middleware supplied original query', () => {
  const request = new NextRequest('https://auth.example.test/application/o/authorize?redirect_uri=https%3A%2F%2Fevil.test');
  assert.throws(() => identitySearchParams(request), /not preserved/);
});
