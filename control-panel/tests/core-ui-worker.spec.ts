import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCoreComponentJSON, reconcileCoreUI, type CoreUIReceipt } from '../../shared/core-component-http';
const receipt: CoreUIReceipt = { schema: 'youeye.core-component.v1', role: 'ui', requestId: 'update-1', manifestSHA256: 'a'.repeat(64), artifactSHA256: 'b'.repeat(64), managed: true, state: 'pending' };

test('CP applies an exact pending UI schema through the bridge and retains reuse identity', async () => {
  const methods: string[] = [];
  const result = await reconcileCoreUI(receipt.artifactSHA256, async (method, body) => {
    methods.push(method);
    if (method === 'POST') assert.deepEqual(body, { requestId: receipt.requestId, manifestSHA256: receipt.manifestSHA256, artifactSHA256: receipt.artifactSHA256 });
    return { ...receipt, state: method === 'POST' ? 'completed' : 'pending' };
  }, receipt);
  assert.equal(result.state, 'completed'); assert.deepEqual(methods, ['GET', 'POST']);
  for (const state of ['started', 'unknown', 'completed'] as const) {
    let calls = 0;
    const observed = await reconcileCoreUI(receipt.artifactSHA256, async method => { assert.equal(method, 'GET'); calls++; return { ...receipt, requestId: 'install-reused', state }; }, { ...receipt, requestId: 'install-reused' });
    assert.equal(observed.requestId, 'install-reused'); assert.equal(observed.state, state); assert.equal(calls, 1);
  }
});

test('UI observation cannot start schema and foreign/malformed receipts fail closed', async () => {
  let writes = 0;
  const observe = async (method: string) => { if (method === 'POST') writes++; return receipt; };
  assert.equal((await reconcileCoreUI(receipt.artifactSHA256, observe)).state, 'pending'); assert.equal(writes, 0);
  await assert.rejects(reconcileCoreUI(receipt.artifactSHA256, observe, { ...receipt, requestId: 'foreign' })); assert.equal(writes, 0);
  for (const changed of [{ artifactSHA256: 'c'.repeat(64) }, { managed: false }, { role: 'cp' }, { requestId: '../escape' }, { state: 'healthy' }]) {
    await assert.rejects(reconcileCoreUI(receipt.artifactSHA256, async () => ({ ...receipt, ...changed }), receipt));
  }
  await assert.rejects(reconcileCoreUI(receipt.artifactSHA256, async method => method === 'GET' ? receipt : { ...receipt, requestId: 'different', state: 'completed' }, receipt));
});

test('bounded streaming parser rejects oversized, invalid UTF-8 and malformed bodies', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify(receipt));
  assert.deepEqual(await readCoreComponentJSON(new Response(encoded).body, 4096), receipt);
  await assert.rejects(readCoreComponentJSON(new Response(encoded).body, 10));
  await assert.rejects(readCoreComponentJSON(new Response(new Uint8Array([0xff])).body, 4096));
  await assert.rejects(readCoreComponentJSON(new Response('not JSON').body, 4096));
  let cancelled = false;
  const large = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } });
  await assert.rejects(readCoreComponentJSON(large, 4096)); assert.equal(cancelled, true);
});
