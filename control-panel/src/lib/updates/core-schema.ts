import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type CoreComponent = { schema: 'youeye.core-component.v1'; role: 'cp' | 'ui'; requestId: string; manifestSHA256: string; artifactSHA256: string };
type SchemaReceipt = CoreComponent & { state: 'started' | 'completed' | 'unknown' };
export type CoreSchemaPaths = { component: string; receipts: string };
const digest = /^[a-f0-9]{64}$/;
const request = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

async function protectedJSON<T>(path: string): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16384 || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Unsafe core schema identity');
    const bytes = Buffer.alloc(stat.size + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) throw new Error('Core schema identity changed');
    return JSON.parse(bytes.subarray(0, stat.size).toString('utf8')) as T;
  } finally { await file.close(); }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

function sameComponent(a: CoreComponent, b: CoreComponent) {
  return a.schema === b.schema && a.role === b.role && a.requestId === b.requestId
    && a.manifestSHA256 === b.manifestSHA256 && a.artifactSHA256 === b.artifactSHA256;
}

export async function coreSchemaComponent(role: 'cp' | 'ui', path = '/etc/youeye/core-component.json'): Promise<CoreComponent | null> {
  let value: CoreComponent;
  try { value = await protectedJSON<CoreComponent>(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling selected marker is damaged state, not a legacy runtime.
      try { await lstat(path); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ENOENT') {
          const indicators = [join(dirname(path), 'core-artifact-sha256')];
          if (path === '/etc/youeye/core-component.json' && role === 'cp') indicators.push('/var/lib/youeye-state/core-selection/core-release.json', '/var/lib/youeye-state/core-selection/core-release.json.sig');
          for (const indicator of indicators) {
            try { await lstat(indicator); }
            catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error('Core installation identity unavailable'); }
            throw new Error('Selected core component marker is missing');
          }
          return null;
        }
      }
    }
    throw new Error('Core component identity unavailable');
  }
  if (value.schema !== 'youeye.core-component.v1' || value.role !== role || !request.test(value.requestId)
    || !digest.test(value.manifestSHA256) || !digest.test(value.artifactSHA256)) throw new Error('Invalid core component identity');
  return { schema: value.schema, role: value.role, requestId: value.requestId, manifestSHA256: value.manifestSHA256, artifactSHA256: value.artifactSHA256 };
}

/**
 * New-format CP/ID processes share one durable schema attempt; UI uses the same
 * contract in its own data mount. Native code installs the exact signed payload
 * identity before starting services. Only a completed matching receipt permits
 * another process/restart to skip initialization. Unknown effects never retry.
 * Legacy installations keep their existing schema initialization behavior.
 */
export async function runCoreSchemaOnce(role: 'cp' | 'ui', initialize: () => Promise<void>, paths?: CoreSchemaPaths, restoreRequest?: string): Promise<void> {
  const componentPath = paths?.component ?? '/etc/youeye/core-component.json';
  const component = await coreSchemaComponent(role, componentPath);
  if (!component) return initialize();
  const receipts = schemaReceipts(role, paths);
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const info = await lstat(receipts);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Unsafe core schema receipt directory');
  if (restoreRequest !== undefined && !request.test(restoreRequest)) throw new Error('Exact historical restore request required');
  const identity = restoreRequest === undefined ? component : { ...component,
    requestId: `restore-${createHash('sha256').update(component.requestId + '\0' + restoreRequest).digest('hex')}` };
  const path = schemaReceiptPath(receipts, identity);
  const accept = async () => {
    const receipt = await protectedJSON<SchemaReceipt>(path);
    if (!sameComponent(receipt, identity) || receipt.state !== 'completed') throw new Error('Core schema attempt is running or uncertain; native recovery required');
  };
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return accept(); throw error; }
  const publish = async (state: 'completed' | 'unknown') => {
    const pending = `${path}.result`;
    const output = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(JSON.stringify({ ...identity, state })); await output.sync(); } finally { await output.close(); }
    await rename(pending, path);
    await syncDirectory(dirname(path));
  };
  try {
    await file.writeFile(JSON.stringify({ ...identity, state: 'started' })); await file.sync();
  } finally { await file.close(); }
  await syncDirectory(receipts);
  // Never start if the native payload marker was changed after receipt intent.
  const current = await coreSchemaComponent(role, componentPath);
  if (!current || !sameComponent(current, component)) throw new Error('Core component changed before schema initialization');
  try { await initialize(); }
  catch { await publish('unknown'); throw new Error('Core schema outcome is uncertain; native recovery required'); }
  const finalComponent = await coreSchemaComponent(role, componentPath);
  if (!finalComponent || !sameComponent(finalComponent, component)) {
    await publish('unknown');
    throw new Error('Core component changed during schema initialization');
  }
  await publish('completed');
}

function schemaReceipts(role: 'cp' | 'ui', paths?: CoreSchemaPaths) {
  return paths?.receipts ?? (role === 'cp'
    ? '/var/lib/youeye/state/core-component-schemas' : '/var/lib/youeye/ui-data/.core-component-schemas');
}
function schemaReceiptPath(receipts: string, identity: CoreComponent) {
  const key = createHash('sha256').update([identity.role, identity.requestId, identity.manifestSHA256, identity.artifactSHA256].join('\0')).digest('hex');
  return join(receipts, `${key}.json`);
}
export async function coreSchemaStatus(role: 'cp' | 'ui', paths?: CoreSchemaPaths) {
  const component = await coreSchemaComponent(role, paths?.component);
  if (!component) return { managed: false as const, state: 'legacy' as const };
  let receipt: SchemaReceipt;
  try { receipt = await protectedJSON<SchemaReceipt>(schemaReceiptPath(schemaReceipts(role, paths), component)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { await lstat(schemaReceiptPath(schemaReceipts(role, paths), component)); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ENOENT') return { ...component, managed: true as const, state: 'pending' as const }; }
    }
    throw new Error('Core schema receipt unavailable');
  }
  if (!sameComponent(receipt, component) || !['started', 'completed', 'unknown'].includes(receipt.state)) throw new Error('Core schema receipt differs from installed component');
  return { ...component, managed: true as const, state: receipt.state };
}
