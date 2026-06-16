/**
 * GET /api/market/image?url=<encoded-url>
 * Proxies external images through the CP to avoid CORS issues.
 * Only allows URLs from trusted domains.
 */

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
  // YouEye Forgejo / App Market host — external app icons are served from the
  // catalog repo's raw file URLs (e.g. git.potemk.in/.../raw/icons/<app>.svg).
  'git.potemk.in',
];

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
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
  if (res.ok) {
    return res;
  }

  const fallbackUrl = defaultBranchFallbackUrl(imageUrl);
  if (fallbackUrl) {
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(10_000) });
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

  if (!ALLOWED_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
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
