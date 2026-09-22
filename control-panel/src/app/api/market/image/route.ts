/**
 * GET /api/market/image?url=<encoded-url>
 * Proxies external images through the CP to avoid CORS issues.
 * Only allows URLs from trusted domains.
 */

import { releaseCacheFetch } from '@/lib/releases/cache';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED_DOMAINS = [
  'github.com',
  'raw.githubusercontent.com',
  'avatars.githubusercontent.com',
  'cdn.jsdelivr.net',
  'immich.app',
  'usememos.com',
  'i.ibb.co',
  'jellyfin.org',
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isTrustedImageURL(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash
      && (parsed.hostname === 'catalog.youeye.me' || ALLOWED_DOMAINS.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)));
  } catch {
    return false;
  }
}

async function fetchTrustedImage(raw: string): Promise<Response> {
  let current = raw;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isTrustedImageURL(current)) throw new Error('Image URL or redirect is not trusted');
    const response = await releaseCacheFetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects === 5) throw new Error('Image download exceeded five redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Image redirect omitted Location');
    current = new URL(location, current).toString();
  }
  throw new Error('Image download did not terminate');
}

function placeholderImageResponse() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="App icon"><rect width="96" height="96" rx="20" fill="#eff6ff"/><path d="M28 30h24l16 16v20H28V30zm23 3v14h14" fill="none" stroke="#2563eb" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function defaultBranchFallbackUrl(imageUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'raw.githubusercontent.com') {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] === 'main') {
    return null;
  }

  parts[2] = 'main';
  parsed.pathname = `/${parts.join('/')}`;
  return parsed.toString();
}

async function fetchImage(imageUrl: string): Promise<Response> {
  const res = await fetchTrustedImage(imageUrl);
  if (res.ok) {
    return res;
  }

  const fallbackUrl = defaultBranchFallbackUrl(imageUrl);
  if (fallbackUrl) {
    const fallbackRes = await fetchTrustedImage(fallbackUrl);
    if (fallbackRes.ok) {
      return fallbackRes;
    }
  }

  return res;
}

export async function GET(request: Request) {
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
    const res = await fetchImage(imageUrl);
    if (!res.ok) {
      return placeholderImageResponse();
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = await res.arrayBuffer();

    return new NextResponse(Buffer.from(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    console.warn('[market/image] Falling back to placeholder:', err);
    return placeholderImageResponse();
  }
}
