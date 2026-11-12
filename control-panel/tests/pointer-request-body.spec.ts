import assert from 'node:assert/strict';
import test from 'node:test';
import { PointerRequestTooLarge, readPointerRequestBody } from '../src/lib/pointer/request-body';

test('Pointer proxy bounds chunked input and cancels excess without forwarding it', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  });
  const request = new Request('http://localhost/', {method: 'POST', body, duplex: 'half'} as RequestInit);
  await assert.rejects(readPointerRequestBody(request, 5), PointerRequestTooLarge);
  assert.equal(cancelled, true);
});

test('Pointer proxy accepts exact bound and rejects declared oversized input', async () => {
  assert.equal(new TextDecoder().decode(await readPointerRequestBody(new Request('http://localhost/', {method: 'POST', body: 'abcde'}), 5)), 'abcde');
  await assert.rejects(readPointerRequestBody(new Request('http://localhost/', {method: 'POST', headers: {'content-length': '6'}, body: 'abcde'}), 5), PointerRequestTooLarge);
});
