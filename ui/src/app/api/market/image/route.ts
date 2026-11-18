/**
 * GET /api/market/image?url=<encoded-url>
 *
 * Proxies external images so the app drawer can display icons for
 * external/Market-installed apps.  Icon URLs are stored in the DB as
 * "/api/market/image?url=..." (relative to whichever host serves
 * the page).  The CP already has this endpoint; the UI mirrors it
 * so icons render on the UI domain too.
 *
 * Only allows URLs from trusted domains.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED_DOMAINS = [
  'github.com',
  'raw.githubusercontent.com',
  'avatars.githubusercontent.com',
  'immich.app',
  'usememos.com',
  'i.ibb.co',
  'jellyfin.org',
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Every answer is inert in the box's origin: an SVG opened directly cannot run
// script, and the browser never sniffs a different type.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
} as const;

// The only types this proxy ever answers with.
const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};
const IMAGE_TYPES = new Set(Object.values(IMAGE_TYPE_BY_EXTENSION));
// Hosts such as raw.githubusercontent.com label every file like this; then the
// extension decides.
const GENERIC_TYPES = new Set(['', 'text/plain', 'application/octet-stream', 'binary/octet-stream']);

function imageContentType(upstreamType: string | null, imageUrl: string): string | null {
  const type = (upstreamType ?? '').split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return type;
  if (!GENERIC_TYPES.has(type)) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(new URL(imageUrl).pathname)?.[1]?.toLowerCase();
  return (extension && IMAGE_TYPE_BY_EXTENSION[extension]) || null;
}

/** The largest image this proxy passes on; it is reachable without sign-in, so nothing larger is ever buffered. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The body, or null when it is (or announces itself as) larger than MAX_IMAGE_BYTES: reading stops at the cap. */
async function readCappedBody(res: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  const announced = Number(res.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > MAX_IMAGE_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function secured<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

function isTrustedImageURL(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash
      && ALLOWED_DOMAINS.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

async function fetchTrustedImage(raw: string): Promise<Response> {
  let current = raw;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isTrustedImageURL(current)) throw new Error('Image URL or redirect is not trusted');
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects === 5) throw new Error('Image download exceeded five redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Image redirect omitted Location');
    current = new URL(location, current).toString();
  }
  throw new Error('Image download did not terminate');
}

export async function GET(request: Request) {
  return secured(await answer(request));
}

async function answer(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'url parameter required' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!isTrustedImageURL(parsed.toString())) {
    return NextResponse.json({ error: 'Domain not allowed' }, { status: 403 });
  }

  try {
    const res = await fetchTrustedImage(imageUrl);
    if (!res.ok) {
      return NextResponse.json({ error: `Failed to fetch: ${res.status}` }, { status: 502 });
    }
    const contentType = imageContentType(res.headers.get('content-type'), imageUrl);
    if (!contentType) {
      return NextResponse.json({ error: 'Upstream is not an allowed image type' }, { status: 502 });
    }
    const body = await readCappedBody(res);
    if (!body) {
      return NextResponse.json({ error: 'Upstream image is larger than 5 MiB' }, { status: 502 });
    }

    return new NextResponse(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `Proxy error: ${err}` }, { status: 502 });
  }
}
