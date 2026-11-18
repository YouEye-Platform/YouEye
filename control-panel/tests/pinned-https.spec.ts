/**
 * The one HTTPS transport of market files and of apps added by URL (`pinnedHttpsRequest` in url-app.ts): it connects
 * to the checked address only, refuses a body that announces more than the limit before reading it, and stops
 * reading a body without an announced size at the limit. Driven here over a fake `node:https`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { load } from './fixtures/market-world';

const nodeRequire = createRequire(import.meta.url);

interface Scripted {
  peer?: string;
  status?: number;
  headers?: Record<string, string>;
  /** Called once the response exists; emits the body. */
  body?: (response: EventEmitter, request: FakeRequest) => void;
  /** Never answer (the idle timeout or the deadline must end it). */
  silent?: boolean;
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  idle?: { ms: number; fire: () => void };
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
  setTimeout(ms: number, fire: () => void) { this.idle = { ms, fire }; return this; }
  end() { return this; }
}

function transport(script: Scripted) {
  const seen: { options?: Record<string, any>; request?: FakeRequest } = {};
  const https = {
    request: (_url: URL, options: Record<string, any>, onResponse: (response: EventEmitter) => void) => {
      const request = new FakeRequest();
      seen.options = options;
      seen.request = request;
      if (!script.silent) {
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), {
            socket: { remoteAddress: script.peer ?? '93.184.216.34' }, statusCode: script.status ?? 200, headers: script.headers ?? {},
          });
          onResponse(response);
          script.body?.(response, request);
        });
      }
      return request;
    },
  };
  const module = load('src/lib/market/url-app.ts', {
    'node:https': https, 'node:net': nodeRequire('node:net'), 'node:dns/promises': {},
    './constants': { CONTAINER_DOMAIN: 'youeye' }, './app-format/compile': {}, './app-format/parse': { MAX_DOCUMENT_BYTES: 1024 * 1024 },
  });
  const get = (extra: Record<string, unknown> = {}) => module.pinnedHttpsRequest(new URL('https://markets.example.org/m/market.json'),
    { address: '93.184.216.34', family: 4 }, {
      headers: { 'User-Agent': 'test' }, maxBytes: 1000, timeoutMs: 5000,
      messages: { tooLarge: 'too large', timeout: 'timed out', failed: 'failed' }, ...extra,
    });
  return { get, seen };
}

test('the request connects to the checked address only, with the host name for TLS and a fresh connection by default', async () => {
  const { get, seen } = transport({ body: (response) => { response.emit('data', Buffer.from('hello')); response.emit('end'); } });
  const answer = await get();
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, Buffer.from('hello'));
  assert.equal(seen.options!.agent, false);
  assert.equal(seen.options!.servername, 'markets.example.org');
  assert.equal(seen.options!.method, 'GET');
  // Whatever host is looked up, the answer is the checked address.
  const answers: unknown[] = [];
  seen.options!.lookup('elsewhere.example.org', {}, (...args: unknown[]) => answers.push(args));
  assert.deepEqual(answers, [[null, '93.184.216.34', 4]]);
  // A connection that ended up elsewhere is refused before a byte of the body is used.
  let readers = -1;
  const elsewhere = transport({ peer: '10.0.0.7', body: (response) => { readers = response.listenerCount('data'); } });
  await assert.rejects(elsewhere.get(), /did not go to the checked address/);
  assert.equal(elsewhere.seen.request!.destroyed, true);
  assert.equal(readers, 0, 'no reader was attached to the body');
});

test('a body that announces more than the limit is refused before it is read', async () => {
  let listened = false;
  const { get, seen } = transport({ headers: { 'content-length': '1001' }, body: (response) => { listened = response.listenerCount('data') > 0; } });
  await assert.rejects(get(), /too large/);
  assert.equal(seen.request!.destroyed, true);
  assert.equal(listened, false, 'no reader was attached to the body');
  // Exactly the limit passes.
  const exact = transport({ headers: { 'content-length': '1000' }, body: (response) => { response.emit('data', Buffer.alloc(1000)); response.emit('end'); } });
  assert.equal((await exact.get()).body.length, 1000);
});

test('a body without an announced size is read only up to the limit, then the connection is closed', async () => {
  let sent = 0;
  const { get, seen } = transport({ body: (response, request) => {
    // An endless stream in 300-byte chunks; it stops when the connection is destroyed.
    while (!request.destroyed && sent < 100_000) { sent += 300; response.emit('data', Buffer.alloc(300)); }
  } });
  await assert.rejects(get(), /too large/);
  assert.equal(seen.request!.destroyed, true);
  assert.equal(sent, 1200, 'reading stopped with the chunk that crossed the limit');
  // A lying content-length does not help either.
  const lying = transport({ headers: { 'content-length': '10' }, body: (response, request) => {
    for (let n = 0; n < 10 && !request.destroyed; n += 1) response.emit('data', Buffer.alloc(300));
  } });
  await assert.rejects(lying.get(), /too large/);
});

test('an idle connection and an overall deadline end the request; a connection pool is used only when given', async () => {
  const idle = transport({ silent: true });
  const waiting = idle.get();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(idle.seen.request!.idle!.ms, 5000);
  idle.seen.request!.idle!.fire();
  await assert.rejects(waiting, /timed out/);

  const slow = transport({ silent: true });
  await assert.rejects(slow.get({ deadlineMs: 20 }), /timed out/);
  assert.equal(slow.seen.request!.destroyed, true);

  const pool = { marker: 'pool' };
  const pooled = transport({ body: (response) => { response.emit('data', Buffer.from('x')); response.emit('end'); } });
  await pooled.get({ agent: pool });
  assert.equal(pooled.seen.options!.agent, pool);
});
