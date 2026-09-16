import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptTLSSecret,
  encryptTLSSecret,
  isEncryptedTLSSecret,
} from '../src/lib/acme/secret-crypto';

const privateKey = [
  '-----BEGIN PRIVATE KEY-----',
  'unit-test-key-material',
  '-----END PRIVATE KEY-----',
].join('\n');

test('TLS private material is authenticated, encrypted, and decryptable', () => {
  const deployKey = Buffer.from('unit-test-deployment-key-material-a');
  const first = encryptTLSSecret(privateKey, deployKey);
  const second = encryptTLSSecret(privateKey, deployKey);

  assert.equal(isEncryptedTLSSecret(first), true);
  assert.doesNotMatch(first, /PRIVATE KEY|unit-test-key-material/);
  assert.notEqual(first, second, 'a fresh nonce must produce a distinct envelope');
  assert.equal(decryptTLSSecret(first, deployKey), privateKey);
});

test('TLS private material rejects a different deployment key', () => {
  const encrypted = encryptTLSSecret(
    privateKey,
    Buffer.from('unit-test-deployment-key-material-a'),
  );
  assert.throws(
    () => decryptTLSSecret(
      encrypted,
      Buffer.from('unit-test-deployment-key-material-b'),
    ),
    /authentication failed/,
  );
});
