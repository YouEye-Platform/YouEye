import assert from 'node:assert/strict';
import test from 'node:test';
import { restartServiceRequest } from '../src/lib/health/client';

test('service restart sends the current CSRF token and requires a success receipt', async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const request = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return Response.json(calls.length === 1 ? { csrfToken: 'test-csrf' } : { success: true });
  }) as typeof fetch;
  await restartServiceRequest('postgres', request);
  assert.equal(calls[0].url, '/settings/api/auth/csrf');
  assert.equal(calls[1].url, '/api/health/services/postgres/restart');
  assert.equal(calls[1].options?.method, 'POST');
  assert.equal(new Headers(calls[1].options?.headers).get('X-CSRF-Token'), 'test-csrf');
});

test('missing CSRF never sends a mutation and restart rejection remains visible', async () => {
  let calls = 0;
  await assert.rejects(restartServiceRequest('postgres', (async () => {
    calls++; return Response.json({ csrfToken: null });
  }) as typeof fetch), /protected restart request/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(restartServiceRequest('postgres', (async () => {
    return ++calls === 1 ? Response.json({ csrfToken: 'test-csrf' }) : Response.json({ error: 'Denied' }, { status: 403 });
  }) as typeof fetch), /Denied/);
  calls = 0;
  await assert.rejects(restartServiceRequest('postgres', (async () => {
    return ++calls === 1 ? Response.json({ csrfToken: 'test-csrf' }) : Response.json({});
  }) as typeof fetch), /Restart failed/);
});
