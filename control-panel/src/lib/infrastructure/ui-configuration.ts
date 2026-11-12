import { lstat, readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

export type UIConfiguration = {
  identity_url: string; identity_internal_url: string;
  client_id: string; client_secret: string; jwt_secret: string;
  database_url: string; domain: string; base_url: string;
};

async function readSavedConfiguration(): Promise<string | undefined> {
  const path = '/var/lib/youeye/ui/.env';
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error('Persistent UI configuration is not protected');
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Restore the existing identity and database binding, without issuing secrets. */
export async function reapplySavedUIConfiguration(
  required: boolean,
  apply: (configuration: UIConfiguration) => Promise<unknown>,
  read: () => Promise<string | undefined> = readSavedConfiguration,
): Promise<boolean> {
  const text = await read();
  if (text === undefined) {
    if (required) throw new Error('Persistent UI configuration is unavailable');
    return false; // A fresh appliance is configured by the setup wizard.
  }
  const keys = ['IDENTITY_URL', 'IDENTITY_INTERNAL_URL', 'IDENTITY_CLIENT_ID',
    'IDENTITY_CLIENT_SECRET', 'JWT_SECRET', 'DATABASE_URL', 'UI_EXTERNAL_URL'];
  const values = new Map<string, string>();
  try {
    for (const line of text.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index < 0 || line.startsWith('#')) continue;
      const key = line.slice(0, index);
      if (!keys.includes(key)) continue;
      if (values.has(key)) throw new Error();
      values.set(key, line.slice(index + 1));
    }
    if (!required && !values.get('IDENTITY_CLIENT_ID')
      && !values.get('IDENTITY_CLIENT_SECRET')) return false;
    if (keys.some(key => !values.get(key))) throw new Error();
    for (const key of ['IDENTITY_URL', 'IDENTITY_INTERNAL_URL', 'UI_EXTERNAL_URL']) {
      if (!['http:', 'https:'].includes(new URL(values.get(key)!).protocol)) throw new Error();
    }
    if (!['postgres:', 'postgresql:'].includes(new URL(values.get('DATABASE_URL')!).protocol)) throw new Error();
  } catch {
    throw new Error('Persistent UI configuration is invalid');
  }
  await apply({
    identity_url: values.get('IDENTITY_URL')!,
    identity_internal_url: values.get('IDENTITY_INTERNAL_URL')!,
    client_id: values.get('IDENTITY_CLIENT_ID')!,
    client_secret: values.get('IDENTITY_CLIENT_SECRET')!,
    jwt_secret: values.get('JWT_SECRET')!,
    database_url: values.get('DATABASE_URL')!,
    domain: new URL(values.get('UI_EXTERNAL_URL')!).host,
    base_url: values.get('UI_EXTERNAL_URL')!,
  });
  return true;
}

/** Reconciliation can recreate the UI before Spine's update finalization runs. */
export async function reapplySavedUIBridgeToken(
  required: boolean,
  applyAndRead: (token: string) => Promise<string | undefined>,
  read: () => Promise<string | undefined> = async () => {
    try {
      const path = '/var/lib/youeye/control/.bridge_token';
      const stat = await lstat(path);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('Persistent UI bridge authority is not protected');
      }
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
): Promise<boolean> {
  const saved = await read();
  if (saved === undefined) {
    if (required) throw new Error('Persistent UI bridge authority is unavailable');
    return false;
  }
  const token = saved.trim();
  if (!token || /[\r\n\0]/.test(token)) throw new Error('Persistent UI bridge authority is invalid');
  try {
    const actual = await applyAndRead(token);
    const expectedBytes = Buffer.from(token);
    const actualBytes = Buffer.from(actual ?? '');
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error();
    }
  } catch {
    throw new Error('UI bridge authority reconciliation failed');
  }
  return true;
}

export async function reconcileUIBridgeFile(
  token: string,
  read: () => Promise<{ token: string; mode: string } | undefined>,
  write: () => Promise<void>,
  restart: () => Promise<void>,
  prepareParent: () => Promise<void> = async () => {},
): Promise<string | undefined> {
  const matches = (value: Awaited<ReturnType<typeof read>>) => value?.token === token && value.mode === '600';
  if (matches(await read())) return token;
  await prepareParent();
  await write();
  const actual = await read();
  if (!matches(actual)) return undefined;
  // UI caches a missing token too. Clear that state after repairing the file.
  await restart();
  return actual!.token;
}
