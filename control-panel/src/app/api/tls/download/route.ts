/**
 * Certificate Download API
 *
 * GET /api/tls/download?type=cert|key|ca|bundle
 *   - cert: Download the current certificate (PEM)
 *   - key: Download the private key (PEM)
 *   - ca: Download Caddy's internal CA root cert (PEM) — for browser trust
 *   - bundle: Download cert + key together as a JSON object
 */

import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { tlsStorage } from '@/lib/acme/storage';
import { execShell } from '@/lib/incus/server';

type DownloadType = 'cert' | 'key' | 'ca' | 'bundle';
const VALID_TYPES: DownloadType[] = ['cert', 'key', 'ca', 'bundle'];

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return new Response('Unauthorized', { status: 401 });
    }

    const type = request.nextUrl.searchParams.get('type') as DownloadType | null;
    if (!type || !VALID_TYPES.includes(type)) {
      return Response.json(
        { error: `Invalid type. Use one of: ${VALID_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    // CA cert — always available (from Caddy's internal CA)
    if (type === 'ca') {
      const result = await execShell(
        'youeye-caddy',
        'cat /data/caddy/pki/authorities/local/root.crt',
        { timeout: 10000 },
      );
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        return new Response('CA certificate not available', { status: 404 });
      }
      return new Response(result.stdout, {
        headers: {
          'Content-Type': 'application/x-pem-file',
          'Content-Disposition': 'attachment; filename="youeye-ca.crt"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Cert, key, or bundle — requires stored external cert
    const stored = await tlsStorage.getCert();
    if (!stored) {
      return Response.json(
        { error: 'No external certificate is stored. The server is using self-signed certificates.' },
        { status: 404 },
      );
    }

    if (type === 'cert') {
      return new Response(stored.certPem, {
        headers: {
          'Content-Type': 'application/x-pem-file',
          'Content-Disposition': 'attachment; filename="youeye-cert.pem"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (type === 'key') {
      return new Response(stored.keyPem, {
        headers: {
          'Content-Type': 'application/x-pem-file',
          'Content-Disposition': 'attachment; filename="youeye-key.pem"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // bundle
    return Response.json(
      {
        certificate: stored.certPem,
        privateKey: stored.keyPem,
        domains: stored.domains,
        issuer: stored.issuer,
        expiresAt: stored.expiresAt,
        issuedAt: stored.issuedAt,
      },
      {
        headers: {
          'Content-Disposition': 'attachment; filename="youeye-tls-bundle.json"',
          'Cache-Control': 'no-cache',
        },
      },
    );
  } catch (error) {
    console.error('[TLS/Download] Failed:', error);
    return new Response('Failed to download certificate', { status: 500 });
  }
}
