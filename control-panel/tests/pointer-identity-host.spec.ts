import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerIdentityHosts } from '../src/lib/pointer/identity-host';

const original = '127.0.0.1 localhost\n::1 localhost ip6-localhost\n10.1.2.4 unrelated.example.test # owner\n';
test('managed identity resolves locally while preserving unrelated host entries', () => {
  const result = pointerIdentityHosts(original, 'id.example.test', '10.1.2.13');
  assert.ok(result.startsWith(original));
  assert.match(result, /10\.1\.2\.13\tid\.example\.test\t# youeye-managed-pointer-identity\n$/);
  assert.equal(pointerIdentityHosts(result, 'id.example.test', '10.1.2.13'), result);
});
test('domain change and fresh restore replace only the owned authority and address', () => {
  const previous = pointerIdentityHosts(original, 'id.example.test', '10.1.2.13');
  const result = pointerIdentityHosts(previous, 'identity.new.example.test', '10.3.4.13');
  assert.ok(result.startsWith(original));
  assert.ok(!result.includes('\tid.example.test\t'));
  assert.match(result, /10\.3\.4\.13\tidentity\.new\.example\.test/);
});
test('foreign records, duplicate ownership and malformed addresses fail closed', () => {
  assert.throws(() => pointerIdentityHosts(original, 'unrelated.example.test', '10.1.2.13'), /Unmanaged/);
  assert.throws(() => pointerIdentityHosts(original + '10.8.9.1 ID.EXAMPLE.TEST alias\n', 'id.example.test', '10.1.2.13'), /Unmanaged/);
  const owned = pointerIdentityHosts('', 'id.example.test', '10.1.2.13');
  assert.throws(() => pointerIdentityHosts(owned + owned, 'id.example.test', '10.1.2.13'), /Ambiguous/);
  for (const host of ['id.example.test\nother', 'https://id.example.test', '-id.example.test', 'id..test', 'x'.repeat(64) + '.test']) {
    assert.throws(() => pointerIdentityHosts(original, host, '10.1.2.13'), /Invalid/);
  }
  for (const ip of ['127.0.0.1', '0.1.2.3', '169.254.1.2', '::1', '10.1.2.13\nother']) {
    assert.throws(() => pointerIdentityHosts(original, 'id.example.test', ip), /Invalid/);
  }
});
