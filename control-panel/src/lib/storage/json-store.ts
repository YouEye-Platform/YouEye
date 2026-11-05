import { readFile, writeFile, mkdir, rename, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

const STATE_DIR = '/var/lib/youeye/state';

/**
 * Read a JSON file. Returns null if file doesn't exist.
 */
export async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Write a JSON file atomically (write to .tmp, then rename).
 * Rename is atomic on Linux within the same filesystem.
 */
export async function writeJSON<T>(filePath: string, data: T): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Get the full path for a state file.
 */
export function statePath(filename: string): string {
  return path.join(STATE_DIR, filename);
}
