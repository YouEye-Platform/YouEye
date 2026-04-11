/**
 * GET /api/market/image?url=<encoded-url>
 * Proxies external images through the CP to avoid CORS/TLS issues.
 * Only allows URLs from trusted domains.
 *
 * For git.byka.wtf (self-signed TLS), uses Node.js https module with
 * rejectUnauthorized: false. For all other allowed domains, uses standard fetch.
 */

import { NextResponse } from 'next/server';
import https from 'https';

export const dynamic = 'force-dynamic';

const ALLOWED_DOMAINS = [
  'git.byka.wtf',
  'raw.githubusercontent.com',
  'github.com',
  'cdn.jsdelivr.net',
  'immich.app',
  'usememos.com',
  'i.ibb.co',
];

/** Domains that use self-signed certificates and need TLS verification skipped */
const INSECURE_DOMAINS = ['git.byka.wtf'];

/**
 * Fetch an image from a self-signed cert domain using Node.js https
 * with rejectUnauthorized: false.
 */
function fetchInsecure(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 10_000,
    };

    const req = https.request(options, (res) => {
      // Follow redirects (Gitea sometimes 302s)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchInsecure(redirectUrl).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          buffer,
          contentType: res.headers['content-type'] || 'application/octet-stream',
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
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
    let buffer: Buffer | ArrayBuffer;
    let contentType: string;

    if (INSECURE_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      // Self-signed cert domain — use Node.js https with rejectUnauthorized: false
      const result = await fetchInsecure(imageUrl);
      buffer = result.buffer;
      contentType = result.contentType;
    } else {
      // Standard fetch for trusted domains
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return NextResponse.json({ error: `Failed to fetch: ${res.status}` }, { status: 502 });
      }
      contentType = res.headers.get('content-type') || 'application/octet-stream';
      buffer = await res.arrayBuffer();
    }

    return new NextResponse(Buffer.from(buffer as ArrayBuffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `Proxy error: ${err}` }, { status: 502 });
  }
}
