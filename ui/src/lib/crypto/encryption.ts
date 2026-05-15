/**
 * Encryption Module
 *
 * AES-256-GCM encryption/decryption for timeline entries.
 * Key derivation from PIN via PBKDF2 with 600k iterations.
 * All operations use Node.js built-in crypto (Web Crypto API).
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const NONCE_LENGTH = 12; // 96-bit IV for AES-GCM
const SALT_LENGTH = 32;
const DEFAULT_ITERATIONS = 600000;

/** Derive an AES-256 key from a PIN and salt using PBKDF2 */
export async function deriveKey(
  pin: string,
  salt: Uint8Array,
  iterations = DEFAULT_ITERATIONS
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    true, // extractable for session storage
    ["encrypt", "decrypt"]
  );
}

/** Export a CryptoKey to raw bytes */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/** Import raw key bytes back into a CryptoKey */
export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw.buffer as ArrayBuffer,
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );
}

/** Generate a random salt */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/** Generate a random nonce/IV */
export function generateNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
}

/** Hash a derived key for PIN verification (SHA-256 of exported key) */
export async function hashKey(key: CryptoKey): Promise<string> {
  const raw = await exportKey(key);
  const hash = await crypto.subtle.digest("SHA-256", raw.buffer as ArrayBuffer);
  return uint8ToBase64(new Uint8Array(hash));
}

/** Encrypt plaintext data with AES-256-GCM */
export async function encrypt(
  data: string,
  key: CryptoKey
): Promise<{ ciphertext: string; nonce: string }> {
  const encoder = new TextEncoder();
  const nonce = generateNonce();

  const iv = nonce.buffer as ArrayBuffer;
  const plaintext = encoder.encode(data);
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    plaintext.buffer as ArrayBuffer
  );

  return {
    ciphertext: uint8ToBase64(new Uint8Array(encrypted)),
    nonce: uint8ToBase64(nonce),
  };
}

/** Decrypt ciphertext with AES-256-GCM */
export async function decrypt(
  ciphertext: string,
  nonce: string,
  key: CryptoKey
): Promise<string> {
  const decoder = new TextDecoder();
  const nonceBytes = base64ToUint8(nonce);
  const ciphertextBytes = base64ToUint8(ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: nonceBytes.buffer as ArrayBuffer },
    key,
    ciphertextBytes.buffer as ArrayBuffer
  );

  return decoder.decode(decrypted);
}

/** Encrypt a derived key with a session key for storage */
export async function encryptDerivedKeyForSession(
  derivedKey: CryptoKey,
  sessionKey: Uint8Array
): Promise<{ encryptedKey: string; sessionNonce: string }> {
  const raw = await exportKey(derivedKey);
  const imported = await crypto.subtle.importKey(
    "raw",
    sessionKey.buffer as ArrayBuffer,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt"]
  );
  const nonce = generateNonce();
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: nonce.buffer as ArrayBuffer },
    imported,
    raw.buffer as ArrayBuffer
  );

  return {
    encryptedKey: uint8ToBase64(new Uint8Array(encrypted)),
    sessionNonce: uint8ToBase64(nonce),
  };
}

/** Decrypt a derived key from session storage */
export async function decryptDerivedKeyFromSession(
  encryptedKey: string,
  sessionNonce: string,
  sessionKey: Uint8Array
): Promise<CryptoKey> {
  const imported = await crypto.subtle.importKey(
    "raw",
    sessionKey.buffer as ArrayBuffer,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["decrypt"]
  );
  const nonceBytes = base64ToUint8(sessionNonce);
  const keyBytes = base64ToUint8(encryptedKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: nonceBytes.buffer as ArrayBuffer },
    imported,
    keyBytes.buffer as ArrayBuffer
  );

  return importKey(new Uint8Array(decrypted));
}

// ---- RSA Hybrid Encryption ----
// Uses RSA-OAEP to wrap a per-entry AES key, so entries can be encrypted
// without an active PIN session (public key is always available).

const RSA_ALGORITHM = "RSA-OAEP";
const RSA_HASH = "SHA-256";
const RSA_MODULUS_LENGTH = 2048;

/** Generate an RSA-OAEP keypair for hybrid encryption */
export async function generateKeyPair(): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}> {
  return crypto.subtle.generateKey(
    {
      name: RSA_ALGORITHM,
      modulusLength: RSA_MODULUS_LENGTH,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: RSA_HASH,
    },
    true, // extractable
    ["wrapKey", "unwrapKey"]
  );
}

/** Export an RSA public key to SPKI base64 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("spki", key);
  return uint8ToBase64(new Uint8Array(raw));
}

/** Import an RSA public key from SPKI base64 */
export async function importPublicKey(b64: string): Promise<CryptoKey> {
  const raw = base64ToUint8(b64);
  return crypto.subtle.importKey(
    "spki",
    raw.buffer as ArrayBuffer,
    { name: RSA_ALGORITHM, hash: RSA_HASH },
    true,
    ["wrapKey"]
  );
}

/** Export an RSA private key to PKCS8 bytes */
export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("pkcs8", key);
  return new Uint8Array(raw);
}

/** Import an RSA private key from PKCS8 bytes */
export async function importPrivateKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    raw.buffer as ArrayBuffer,
    { name: RSA_ALGORITHM, hash: RSA_HASH },
    true,
    ["unwrapKey"]
  );
}

/** Encrypt an RSA private key with AES-256-GCM (PIN-derived key) for storage */
export async function encryptPrivateKey(
  privateKey: CryptoKey,
  aesKey: CryptoKey
): Promise<{ encryptedPrivateKey: string; privateKeyNonce: string }> {
  const raw = await exportPrivateKey(privateKey);
  const { ciphertext, nonce } = await encrypt(
    uint8ToBase64(raw), // store as base64 string
    aesKey
  );
  return { encryptedPrivateKey: ciphertext, privateKeyNonce: nonce };
}

/** Decrypt an RSA private key that was encrypted with AES-256-GCM */
export async function decryptPrivateKey(
  encryptedPrivateKey: string,
  privateKeyNonce: string,
  aesKey: CryptoKey
): Promise<CryptoKey> {
  const b64 = await decrypt(encryptedPrivateKey, privateKeyNonce, aesKey);
  const raw = base64ToUint8(b64);
  return importPrivateKey(raw);
}

/**
 * Hybrid encrypt: generate a random AES key, encrypt data with it,
 * then wrap the AES key with the RSA public key.
 * Returns everything needed to store and later decrypt.
 */
export async function hybridEncrypt(
  data: string,
  publicKey: CryptoKey
): Promise<{ ciphertext: string; nonce: string; wrappedKey: string }> {
  // Generate a random per-entry AES-256 key
  const entryKey = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );

  // Encrypt data with the per-entry AES key
  const { ciphertext, nonce } = await encrypt(data, entryKey);

  // Wrap the per-entry AES key with the RSA public key
  const wrapped = await crypto.subtle.wrapKey("raw", entryKey, publicKey, {
    name: RSA_ALGORITHM,
  });

  return {
    ciphertext,
    nonce,
    wrappedKey: uint8ToBase64(new Uint8Array(wrapped)),
  };
}

/**
 * Hybrid decrypt: unwrap the per-entry AES key with the RSA private key,
 * then decrypt the data.
 */
export async function hybridDecrypt(
  ciphertext: string,
  nonce: string,
  wrappedKey: string,
  privateKey: CryptoKey
): Promise<string> {
  // Unwrap the per-entry AES key
  const entryKey = await crypto.subtle.unwrapKey(
    "raw",
    base64ToUint8(wrappedKey).buffer as ArrayBuffer,
    privateKey,
    { name: RSA_ALGORITHM },
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ["decrypt"]
  );

  // Decrypt with the unwrapped AES key
  return decrypt(ciphertext, nonce, entryKey);
}

// ---- Base64 helpers ----

export function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
