/**
 * Secret generation and filesystem storage.
 * Platform secrets live under /var/lib/youeye/<scope>/. App secrets live only in
 * /var/lib/youeye/app-<id>/secrets/<name> (dir 0700, files 0600); see appSecretStoreAt.
 */

import { randomBytes, randomUUID } from 'crypto';
import { constants } from 'fs';
import { readFile, writeFile, mkdir, chmod, unlink, access, lstat, open, rename, rm } from 'fs/promises';
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

/** Check whether a secret exists without reading its value. */
export async function secretExists(app: string, name: string): Promise<boolean> {
  try {
    await access(path.join(BASE_DIR, app, name));
    return true;
  } catch {
    return false;
  }
}

/** Write a secret to disk with restrictive permissions. */
export async function writeSecret(app: string, name: string, value: string): Promise<void> {
  const dir = path.join(BASE_DIR, app);
  // Platform secret directories are private to the Control Panel (never 0777).
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, name), value, { mode: 0o600 });
}

/** Delete a secret if present. */
export async function deleteSecret(app: string, name: string): Promise<void> {
  try {
    await unlink(path.join(BASE_DIR, app, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
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

// ─── App secrets ──────────────────────────────────────────

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_SECRET_NAME = /^[a-z0-9_]{1,40}$/;
/** The app directory's secrets subfolder; nothing else (install.json, data) is ever read as a secret. */
export const APP_SECRETS_DIR = 'secrets';

export function isAppSecretName(name: string): boolean {
  return APP_SECRET_NAME.test(name);
}

/** The secret's file relative to the app directory: `secrets/<name>`. */
export function appSecretFile(name: string): string {
  if (!isAppSecretName(name)) throw new Error('Invalid app secret name');
  return `${APP_SECRETS_DIR}/${name}`;
}

/** The secret name of a relative secret file (`secrets/<name>`); throws for anything else. */
export function appSecretNameFromFile(file: string): string {
  const match = /^secrets\/([a-z0-9_]{1,40})$/.exec(file);
  if (!match) throw new Error('Secret file is outside the app-owned secret directory');
  return match[1];
}

/**
 * App secret storage rooted at `baseDir` (production: /var/lib/youeye). The name is validated
 * again here (defence in depth) and the resolved path must stay directly inside the secrets dir.
 */
export function appSecretStoreAt(baseDir: string) {
  function directory(appId: string): string {
    if (!APP_ID.test(appId)) throw new Error('Invalid app ID for secret storage');
    return path.resolve(baseDir, `app-${appId}`, APP_SECRETS_DIR);
  }

  function secretPath(appId: string, name: string): string {
    if (!isAppSecretName(name)) throw new Error('Invalid app secret name');
    const dir = directory(appId);
    const file = path.resolve(dir, name);
    if (path.dirname(file) !== dir || path.basename(file) !== name) {
      throw new Error('App secret path escapes the app secret directory');
    }
    return file;
  }

  async function ensureDirectory(appId: string): Promise<string> {
    const dir = directory(appId);
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory()) throw new Error('App secret directory is not a directory');
    if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    return dir;
  }

  async function read(appId: string, name: string): Promise<string | null> {
    const file = secretPath(appId, name);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new Error('App secret could not be read safely');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) throw new Error('App secret is not a regular file');
      return (await handle.readFile('utf8')).trim() || null;
    } finally {
      await handle.close();
    }
  }

  async function write(appId: string, name: string, value: string): Promise<void> {
    const file = secretPath(appId, name);
    const dir = await ensureDirectory(appId);
    const temporary = path.join(dir, `.tmp-${randomUUID()}`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(value, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      await chmod(file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function getOrCreate(appId: string, name: string, generator?: () => string): Promise<string> {
    const existing = await read(appId, name);
    if (existing) return existing;
    const value = generator ? generator() : generatePassword(32);
    await write(appId, name, value);
    return value;
  }

  async function remove(appId: string, name: string): Promise<void> {
    await rm(secretPath(appId, name), { force: true });
  }

  /** Remove every secret of the app (delete-data uninstall). */
  async function removeAll(appId: string): Promise<void> {
    const dir = directory(appId);
    await rm(dir, { recursive: true, force: true });
    try {
      await lstat(dir);
      throw new Error('App secrets remain after removal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return { directory, path: secretPath, read, write, getOrCreate, remove, removeAll };
}

const appSecrets = appSecretStoreAt(BASE_DIR);

export const readAppSecret = appSecrets.read;
export const writeAppSecret = appSecrets.write;
export const getOrCreateAppSecret = appSecrets.getOrCreate;
export const deleteAppSecret = appSecrets.remove;
export const deleteAllAppSecrets = appSecrets.removeAll;
export const appSecretPath = appSecrets.path;
