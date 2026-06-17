/**
 * YouEye Names — install identity
 *
 * A local YouEye install proves ownership of its leased name with an Ed25519
 * "install identity" keypair. We generate it once and persist it OUTSIDE the
 * app directory (survives redeploys — pitfall #22), then sign every mutating
 * broker request with it. The broker only ever stores the public-key
 * fingerprint; the private key never leaves this server.
 *
 * Signing matches the broker's `src/domain/signatures.ts`:
 *   - public key  = base64url of the raw 32-byte Ed25519 key
 *   - fingerprint = base64url( sha256(raw public key) )
 *   - signature   = base64url( ed25519_sign(canonical payload) )
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR =
  process.env.YOUEYE_NAMES_DATA_DIR || '/opt/youeye-control-data/youeye-names';
const IDENTITY_FILE = path.join(DATA_DIR, 'install-identity.json');

export interface InstallIdentity {
  privateKey: crypto.KeyObject;
  /** base64url raw 32-byte Ed25519 public key */
  publicKeyRaw: string;
  /** base64url sha256(raw public key) */
  fingerprint: string;
}

interface StoredIdentity {
  privateKeyPem: string;
  publicKeyRaw: string;
  fingerprint: string;
}

function rawPublicKey(publicKey: crypto.KeyObject): string {
  // SPKI DER for Ed25519 is a fixed 12-byte prefix + the 32-byte key.
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(-32).toString('base64url');
}

function fingerprintOf(publicKeyRaw: string): string {
  const raw = Buffer.from(publicKeyRaw, 'base64url');
  return crypto.createHash('sha256').update(raw).digest().toString('base64url');
}

let cached: InstallIdentity | null = null;

/**
 * Load the persisted install identity, generating + persisting one on first use.
 * Cached for the lifetime of the process.
 */
export async function getInstallIdentity(): Promise<InstallIdentity> {
  if (cached) return cached;

  try {
    const stored: StoredIdentity = JSON.parse(
      await fs.readFile(IDENTITY_FILE, 'utf8'),
    );
    const privateKey = crypto.createPrivateKey(stored.privateKeyPem);
    cached = {
      privateKey,
      publicKeyRaw: stored.publicKeyRaw,
      fingerprint: stored.fingerprint,
    };
    return cached;
  } catch {
    // Not yet created (or unreadable) — generate a fresh identity.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyRaw = rawPublicKey(publicKey);
    const fingerprint = fingerprintOf(publicKeyRaw);
    const privateKeyPem = privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      IDENTITY_FILE,
      JSON.stringify({ privateKeyPem, publicKeyRaw, fingerprint }, null, 2),
      { mode: 0o600 },
    );

    cached = { privateKey, publicKeyRaw, fingerprint };
    return cached;
  }
}

/** Ed25519-sign a canonical payload, returning a base64url signature. */
export function signPayload(identity: InstallIdentity, payload: string): string {
  return crypto
    .sign(null, Buffer.from(payload), identity.privateKey)
    .toString('base64url');
}
