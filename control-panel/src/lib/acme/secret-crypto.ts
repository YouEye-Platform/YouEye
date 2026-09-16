import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const FORMAT = 'youeye-tls-secret-v1';
const ALGORITHM = 'aes-256-gcm';

type Envelope = {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

function deriveKey(deploySecret: Buffer): Buffer {
  if (deploySecret.length === 0) {
    throw new Error('deployment secret is empty');
  }
  return createHash('sha256').update(deploySecret).digest();
}

export function isEncryptedTLSSecret(value: string): boolean {
  return value.trim().startsWith(`${FORMAT}:`);
}

export function encryptTLSSecret(plaintext: string, deploySecret: Buffer): string {
  if (!plaintext) throw new Error('TLS secret plaintext is empty');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(deploySecret), iv);
  cipher.setAAD(Buffer.from(FORMAT, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return `${FORMAT}:${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')}`;
}

export function decryptTLSSecret(stored: string, deploySecret: Buffer): string {
  const value = stored.trim();
  const prefix = `${FORMAT}:`;
  if (!value.startsWith(prefix)) {
    throw new Error('unsupported encrypted TLS secret format');
  }

  let envelope: Envelope;
  try {
    envelope = JSON.parse(
      Buffer.from(value.slice(prefix.length), 'base64').toString('utf8'),
    ) as Envelope;
  } catch {
    throw new Error('invalid encrypted TLS secret envelope');
  }
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== ALGORITHM ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('invalid encrypted TLS secret metadata');
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(deploySecret),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(FORMAT, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('encrypted TLS secret authentication failed');
  }
}
