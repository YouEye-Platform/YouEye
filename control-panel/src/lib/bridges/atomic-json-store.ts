import { mkdir, rename, rm, writeFile } from 'fs/promises';
import { dirname } from 'path';

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2));
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
