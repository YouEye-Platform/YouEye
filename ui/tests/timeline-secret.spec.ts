import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pbkdf2Sync } from 'node:crypto';
import { validTimelineSecret } from '../../shared/timeline-secret';
import { deriveKey, exportKey, encrypt, decrypt } from '../src/lib/crypto/encryption';

test('exact secret validation preserves Unicode and UTF-16 boundaries without coercion', () => {
  for (const value of ['1234', '    ', ' leading ', 'слово', '漢字漢字', '🔒🔑', 'e\u0301e\u0301', 'x'.repeat(1024)]) assert.ok(validTimelineSecret(value));
  for (const value of [null, 1234, {}, '', '123', '🔑', 'x'.repeat(1025), 'ab\ud800c', 'abc\udc00']) assert.equal(validTimelineSecret(value), false);
});

test('existing numeric and exact Unicode inputs retain PBKDF2 UTF-8 identity and round-trip encryption', async () => {
  const salt = new Uint8Array(32).fill(19);
  for (const value of ['0123', ' leading ', 'слово 漢字 🔑!', 'e\u0301 word', 'é word']) {
    const key = await deriveKey(value, salt);
    assert.deepEqual(Buffer.from(await exportKey(key)), pbkdf2Sync(value, salt, 600000, 32, 'sha256'));
    const encrypted = await encrypt('fixture', key);
    assert.equal(await decrypt(encrypted.ciphertext, encrypted.nonce, key), 'fixture');
  }
  const exact = await deriveKey(' word ', salt);
  const normalized = await deriveKey('word', salt);
  assert.notDeepEqual(await exportKey(exact), await exportKey(normalized));
  assert.notDeepEqual(await exportKey(await deriveKey('e\u0301 word', salt)), await exportKey(await deriveKey('é word', salt)));
});
