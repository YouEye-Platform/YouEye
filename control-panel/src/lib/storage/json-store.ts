import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
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
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, filePath);
}

/**
 * Get the full path for a state file.
 */
export function statePath(filename: string): string {
  return path.join(STATE_DIR, filename);
}
