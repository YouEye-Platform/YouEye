import { chmod, mkdir, open, rename, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
    await chmod(filePath, 0o600);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
