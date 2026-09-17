import { createHash } from 'crypto';
import { lstat, readFile } from 'fs/promises';
import path from 'path';

type CacheObject = { sha256: string; bytes: number };
const cacheRoot = () => process.env.YOUEYE_RELEASE_CACHE || '/var/lib/youeye-state/release-cache';

// Transport only: callers must still verify signatures, selected tags and
// digests using the original release URL and provisioned authority.
export async function cachedReleaseBytes(url: string): Promise<Buffer | null> {
  const root = cacheRoot();
  let raw: Buffer;
  try {
    const stat = await lstat(path.join(root, 'index.json'));
    if (!stat.isFile() || (stat.mode & 0o022) || stat.size > 1024 * 1024) throw new Error('Release cache index is not a protected regular file');
    raw = await readFile(path.join(root, 'index.json'));
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  const index = JSON.parse(raw.toString('utf8')) as { schema: string; objects: Record<string, CacheObject> };
  if (index.schema !== 'youeye.release-cache.v1' || !index.objects) throw new Error('Invalid release cache index');
  const object = index.objects[url];
  if (!object) return null;
  if (!/^[0-9a-f]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes <= 0 || object.bytes > 512 * 1024 * 1024) throw new Error('Invalid release cache object');
  const file = path.join(root, 'objects', object.sha256);
  const stat = await lstat(file);
  if (!stat.isFile() || (stat.mode & 0o022) || stat.size !== object.bytes) throw new Error('Release cache object has invalid size or permissions');
  const bytes = await readFile(file);
  if (bytes.length !== object.bytes || createHash('sha256').update(bytes).digest('hex') !== object.sha256) throw new Error('Release cache object digest rejected');
  return bytes;
}

export async function releaseCacheFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const method = init?.method || (input instanceof Request ? input.method : 'GET');
  const url = input instanceof Request ? input.url : input.toString();
  if (method.toUpperCase() === 'GET') {
    const cached = await cachedReleaseBytes(url);
    if (cached) return new Response(new Uint8Array(cached), { status: 200, headers: { 'X-YouEye-Release-Transport': 'verified-local-cache' } });
  }
  return fetch(input, init);
}
