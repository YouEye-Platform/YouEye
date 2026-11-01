import assert from 'node:assert/strict';
import test from 'node:test';
import { runNamesEnrollment } from '../src/lib/youeye-names/popup';

function fixture() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const messages: Array<{ message: Record<string, unknown>; origin: string }> = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  let destination = '';
  const popup = {
    closed: false,
    close() { this.closed = true; },
    postMessage(message: Record<string, unknown>, origin: string) { messages.push({ message, origin }); },
    location: { replace(url: string) { destination = url; } },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    open: () => popup, location: { origin: 'https://setup.test' },
    addEventListener: (_: string, callback: (event: MessageEvent) => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: (event: MessageEvent) => void) => listeners.delete(callback),
    setTimeout, setInterval,
  } });
  globalThis.fetch = async (url) => Response.json(String(url).endsWith('/csrf')
    ? { csrfToken: 'synthetic-csrf-fixture' }
    : { challenge: { purpose: 'lease_claim', name: 'solar-dale', serviceOrigin: 'https://names.test',
      enrollmentUrl: 'https://names.test/enroll', context: 'fixture-context', cdata: 'fixture-cdata',
      publicKey: 'fixture-public-key', installFingerprint: 'fixture-fingerprint',
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  const session = () => new URLSearchParams(new URL(destination).hash.slice(1)).get('session')!;
  const ready = () => ({ protocol: 'youeye-names.enroll-popup', v: 1, type: 'ready', sessionId: session() });
  const result = () => ({ protocol: 'youeye-names.enroll-popup', v: 1, type: 'result', sessionId: session(),
    purpose: 'lease_claim', proof: 'synthetic-proof-value-for-tests-only',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    binding: { installFingerprint: 'fixture-fingerprint', name: 'solar-dale' } });
  const emit = (data: unknown, source: unknown = popup, origin = 'https://names.test') => {
    for (const listener of listeners) listener({ data, source, origin } as MessageEvent);
  };
  return { popup, messages, ready, result, emit, listeners,
    async opened() {
      for (let attempt = 0; attempt < 20 && !destination; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(destination);
      assert.equal(new URL(destination).search, '');
    },
    restore() {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

test('popup rejects hostile/stale/malformed messages and accepts one exact result after initialization', async () => {
  const f = fixture();
  const abort = new AbortController();
  let accepted = 0;
  let release!: () => void;
  const pending = runNamesEnrollment('lease_claim', { name: 'solar-dale', signal: abort.signal,
    accept: async () => { accepted++; await new Promise<void>(resolve => { release = resolve; }); } });
  try {
    await f.opened();
    f.emit(f.result()); // No ready/init handshake yet.
    f.emit(f.ready(), {});
    f.emit(f.ready(), f.popup, 'https://wrong.test');
    assert.equal(f.messages.length, 0);
    f.emit(f.ready());
    for (const invalid of [
      { ...f.result(), expiresAt: 'not-a-date' },
      { ...f.result(), expiresAt: new Date(Date.now() - 1000).toISOString() },
      { ...f.result(), sessionId: 'old-session' },
      { ...f.result(), purpose: 'install_register' },
      { ...f.result(), extra: 'untrusted' },
      { ...f.result(), binding: { installFingerprint: 'wrong', name: 'solar-dale' } },
      { ...f.result(), binding: { installFingerprint: 'fixture-fingerprint', name: 'another-name' } },
    ]) f.emit(invalid);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(accepted, 0);
    f.emit(f.result()); f.emit(f.result());
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(accepted, 1);
    assert.equal(f.messages.filter(item => item.message.type === 'ack').length, 0);
    release(); await pending;
    assert.equal(f.messages.filter(item => item.message.type === 'ack').length, 1);
    assert.ok(f.messages.every(item => item.origin === 'https://names.test'));
    assert.equal(f.listeners.size, 0);
  } finally { abort.abort(); await pending.catch(() => {}); f.restore(); }
});

test('early closure returns a usable retry error without accepting proof', async () => {
  const f = fixture();
  let accepted = 0;
  const pending = runNamesEnrollment('lease_claim', { name: 'solar-dale', accept: () => { accepted++; } });
  try {
    const rejected = assert.rejects(pending, /closed before it finished/);
    await f.opened(); f.popup.closed = true;
    await rejected;
    assert.equal(accepted, 0); assert.equal(f.listeners.size, 0);
  } finally { f.restore(); }
});

test('navigation cancellation removes listeners and late results cannot start local acceptance', async () => {
  const f = fixture();
  const abort = new AbortController();
  let accepted = 0;
  const pending = runNamesEnrollment('lease_claim', { name: 'solar-dale', signal: abort.signal, accept: () => { accepted++; } });
  try {
    const rejected = assert.rejects(pending, /cancelled/);
    await f.opened(); f.emit(f.ready()); abort.abort(); f.emit(f.result());
    await rejected;
    assert.equal(accepted, 0); assert.equal(f.listeners.size, 0); assert.equal(f.popup.closed, true);
  } finally { f.restore(); }
});
