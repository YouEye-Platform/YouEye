/**
 * YouEye Names install identity.
 *
 * The Ed25519 private key is the authority for a leased name. A missing file
 * is created once; an unreadable, malformed, or inconsistent file is never
 * replaced silently. This keeps corruption from unexpectedly abandoning a
 * name and prevents concurrent processes from creating different identities.
 */
import crypto from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DATA_DIR =
  process.env.YOUEYE_NAMES_DATA_DIR || '/opt/youeye-control-data/youeye-names';
const IDENTITY_FILE = path.join(DATA_DIR, 'install-identity.json');
const IDENTITY_LOCK = path.join(DATA_DIR, 'install-identity.lock');
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;

export interface InstallIdentity {
  privateKey: crypto.KeyObject;
  /** base64url raw 32-byte Ed25519 public key */
  publicKeyRaw: string;
  /** base64url sha256(raw public key) */
  fingerprint: string;
}

export interface StoredInstallIdentity {
  schema?: 1;
  privateKeyPem: string;
  publicKeyRaw: string;
  fingerprint: string;
}

function rawPublicKey(publicKey: crypto.KeyObject): string {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('youeye_names_identity_key_type_invalid');
  }
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = der.subarray(-32);
  if (raw.length !== 32) {
    throw new Error('youeye_names_identity_public_key_invalid');
  }
  return raw.toString('base64url');
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`youeye_names_identity_${label}_encoding_invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error(`youeye_names_identity_${label}_encoding_invalid`);
  }
  return decoded;
}

function fingerprintOf(publicKeyRaw: string): string {
  const raw = decodeCanonicalBase64Url(publicKeyRaw, 'public_key');
  if (raw.length !== 32) {
    throw new Error('youeye_names_identity_public_key_invalid');
  }
  return crypto.createHash('sha256').update(raw).digest().toString('base64url');
}

/** Validate all persisted fields and prove the private/public key relationship. */
export function validateStoredIdentity(value: unknown): {
  stored: StoredInstallIdentity;
  identity: InstallIdentity;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('youeye_names_identity_format_invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.privateKeyPem !== 'string' ||
    typeof candidate.publicKeyRaw !== 'string' ||
    typeof candidate.fingerprint !== 'string' ||
    (candidate.schema !== undefined && candidate.schema !== 1)
  ) {
    throw new Error('youeye_names_identity_format_invalid');
  }

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(candidate.privateKeyPem);
  } catch {
    throw new Error('youeye_names_identity_private_key_invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('youeye_names_identity_key_type_invalid');
  }

  const derivedPublic = rawPublicKey(crypto.createPublicKey(privateKey));
  if (derivedPublic !== candidate.publicKeyRaw) {
    throw new Error('youeye_names_identity_key_pair_mismatch');
  }
  const expectedFingerprint = fingerprintOf(candidate.publicKeyRaw);
  const suppliedFingerprint = decodeCanonicalBase64Url(
    candidate.fingerprint,
    'fingerprint',
  );
  if (suppliedFingerprint.length !== 32 || expectedFingerprint !== candidate.fingerprint) {
    throw new Error('youeye_names_identity_fingerprint_mismatch');
  }

  return {
    stored: {
      schema: 1,
      privateKeyPem: candidate.privateKeyPem,
      publicKeyRaw: candidate.publicKeyRaw,
      fingerprint: candidate.fingerprint,
    },
    identity: {
      privateKey,
      publicKeyRaw: candidate.publicKeyRaw,
      fingerprint: candidate.fingerprint,
    },
  };
}

async function ensureProtectedDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(DATA_DIR, 0o700);
}

async function assertProtectedRegularFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('youeye_names_identity_file_type_invalid');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('youeye_names_identity_file_permissions_invalid');
  }
}

async function readIdentityFile(): Promise<{
  stored: StoredInstallIdentity;
  identity: InstallIdentity;
}> {
  await assertProtectedRegularFile(IDENTITY_FILE);
  const raw = await fs.readFile(IDENTITY_FILE, 'utf8');
  if (Buffer.byteLength(raw) > 64 * 1024) {
    throw new Error('youeye_names_identity_file_too_large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('youeye_names_identity_json_invalid');
  }
  return validateStoredIdentity(parsed);
}

async function acquireIdentityLock(): Promise<() => Promise<void>> {
  await ensureProtectedDataDir();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await fs.open(
        IDENTITY_LOCK,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return async () => {
        await fs.unlink(IDENTITY_LOCK).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      if (cause.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(IDENTITY_LOCK).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.unlink(IDENTITY_LOCK).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('youeye_names_identity_lock_timeout');
      }
      await delay(50 + crypto.randomInt(100));
    }
  }
}

async function fsyncDataDir(): Promise<void> {
  const handle = await fs.open(DATA_DIR, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeIdentityFile(stored: StoredInstallIdentity): Promise<void> {
  const validated = validateStoredIdentity(stored).stored;
  await ensureProtectedDataDir();
  const temporary = path.join(
    DATA_DIR,
    `.install-identity.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = await fs.open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await fs.rename(temporary, IDENTITY_FILE);
  await fs.chmod(IDENTITY_FILE, 0o600);
  await fsyncDataDir();
}

let cached: InstallIdentity | null = null;
let pending: Promise<InstallIdentity> | null = null;

async function loadOrCreateIdentity(): Promise<InstallIdentity> {
  try {
    return (await readIdentityFile()).identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const release = await acquireIdentityLock();
  try {
    try {
      return (await readIdentityFile()).identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyRaw = rawPublicKey(publicKey);
    const stored: StoredInstallIdentity = {
      schema: 1,
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
      publicKeyRaw,
      fingerprint: fingerprintOf(publicKeyRaw),
    };
    await writeIdentityFile(stored);
    return validateStoredIdentity(stored).identity;
  } finally {
    await release();
  }
}

/** Load the persisted identity, generating it only when the file is absent. */
export async function getInstallIdentity(): Promise<InstallIdentity> {
  if (cached) return cached;
  pending ??= loadOrCreateIdentity();
  try {
    cached = await pending;
    return cached;
  } finally {
    pending = null;
  }
}

/** Return a validated serialisable copy for an owner-requested backup export. */
export async function getStoredInstallIdentity(): Promise<StoredInstallIdentity> {
  return (await readIdentityFile()).stored;
}

/** Atomically replace the identity after a complete bundle validation. */
export async function writeInstallIdentityAtomic(
  stored: StoredInstallIdentity,
): Promise<InstallIdentity> {
  const validated = validateStoredIdentity(stored);
  const release = await acquireIdentityLock();
  try {
    await writeIdentityFile(validated.stored);
    cached = validated.identity;
    return validated.identity;
  } finally {
    await release();
  }
}

/** Ed25519-sign a canonical payload, returning a base64url signature. */
export function signPayload(identity: InstallIdentity, payload: string): string {
  return crypto
    .sign(null, Buffer.from(payload), identity.privateKey)
    .toString('base64url');
}

export const IDENTITY_DATA_DIR = DATA_DIR;
export const IDENTITY_FILE_PATH = IDENTITY_FILE;

/** Drop the process cache after an external identity replacement. */
export function resetIdentityCache(): void {
  cached = null;
  pending = null;
}
