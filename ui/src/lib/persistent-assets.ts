import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const UI_DATA_DIR = process.env.DATA_DIR || '/var/lib/youeye/ui-data';
export const BRANDING_DIR = process.env.BRANDING_DATA_DIR || join(UI_DATA_DIR, 'branding');
export const USER_ASSET_DIR = join(UI_DATA_DIR, 'user-assets');

const imageTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', gif: 'image/gif',
};

export function imageExtension(mime: string): string {
  const entry = Object.entries(imageTypes).find(([, type]) => type === mime);
  if (!entry) throw new Error('Unsupported image type');
  return entry[0];
}

/** Public image URLs retain their existing meaning; bytes live outside code. */
export async function persistentAssetResponse(root: string, parts: string[]): Promise<Response> {
  if (!parts.length || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(part) || part.includes('..'))) {
    return new Response(null, { status: 404 });
  }
  const extension = parts.at(-1)!.split('.').at(-1)!.toLowerCase();
  const contentType = imageTypes[extension];
  if (!contentType) return new Response(null, { status: 404 });
  try {
    let directory = root;
    for (const part of ['', ...parts.slice(0, -1)]) {
      if (part) directory = join(directory, part);
      if (!(await lstat(directory)).isDirectory()) return new Response(null, { status: 404 });
    }
    const file = await open(join(root, ...parts), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return new Response(null, { status: 404 });
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== stat.size) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(bytes.subarray(0, length)), { headers: {
        'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'public, max-age=60',
      } });
    } finally { await file.close(); }
  } catch { return new Response(null, { status: 404 }); }
}
