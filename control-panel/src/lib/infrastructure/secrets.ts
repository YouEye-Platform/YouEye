/**
 * Secret generation and filesystem storage.
 * Secrets are stored under /var/lib/youeye/<app>/ — the host volume
 * is mounted into the CP container with shift=true.
 */

import { randomBytes } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const BASE_DIR = '/var/lib/youeye';

/** Generate a cryptographically random password of given length (URL-safe base64). */
export function generatePassword(length = 32): string {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString('base64url')
    .slice(0, length);
}

/** Generate a hex token (e.g. for API tokens). */
export function generateHexToken(bytes = 20): string {
  return randomBytes(bytes).toString('hex');
}

/** Generate a base64 secret key (e.g. for Django SECRET_KEY). */
export function generateSecretKey(bytes = 50): string {
  return randomBytes(bytes).toString('base64');
}

/** Ensure a directory exists under /var/lib/youeye. */
export async function ensureDataDirectory(appPath: string): Promise<string> {
  const fullPath = path.join(BASE_DIR, appPath);
  if (!existsSync(fullPath)) {
    await mkdir(fullPath, { recursive: true, mode: 0o700 });
  }
  return fullPath;
}

/** Read a secret from disk. Returns null if not found. */
export async function readSecret(app: string, name: string): Promise<string | null> {
  const filePath = path.join(BASE_DIR, app, name);
  try {
    const data = await readFile(filePath, 'utf-8');
    return data.trim();
  } catch {
    return null;
  }
}

/** Write a secret to disk with restrictive permissions. */
export async function writeSecret(app: string, name: string, value: string): Promise<void> {
  const dir = path.join(BASE_DIR, app);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(path.join(dir, name), value, { mode: 0o600 });
}

/**
 * Get an existing secret or generate a new one.
 * Uses the provided generator function, or defaults to generatePassword(32).
 */
export async function getOrCreateSecret(
  app: string,
  name: string,
  generator?: () => string
): Promise<string> {
  const existing = await readSecret(app, name);
  if (existing) return existing;

  const value = generator ? generator() : generatePassword(32);
  await writeSecret(app, name, value);
  return value;
}
