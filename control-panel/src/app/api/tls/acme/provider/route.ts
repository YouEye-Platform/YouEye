import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { issueCertificateWithDnsProvider } from '@/lib/acme/client';
import * as caddy from '@/lib/caddy/client';
import { CloudflareDnsProvider } from '@/lib/dns-providers/cloudflare';
import { getByoDnsProviderConfig, saveByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { readProviderToken } from '@/lib/dns-providers/secrets';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  try {
    const config = await getByoDnsProviderConfig();
    if (!config || config.mode !== 'byo-provider') {
      return NextResponse.json({ error: 'Connect a DNS provider first' }, { status: 400 });
    }
    if (config.provider !== 'cloudflare') {
      return NextResponse.json({ error: 'Unsupported DNS provider' }, { status: 400 });
    }

    const token = await readProviderToken(config.connectionId);
    if (!token) {
      return NextResponse.json({ error: 'DNS provider token is not available' }, { status: 400 });
    }

    const provider = new CloudflareDnsProvider(token);
    const zone = { id: config.zoneId, name: config.zoneName };
    const result = await withTimeout(
      issueCertificateWithDnsProvider(config.domain, provider, zone, true),
      180_000,
      'Certificate issuance',
    );

    await caddy.loadExternalCert(result.certificate, result.privateKey, result.domains);
    const expiresAt = new Date(result.expiresAt);
    const nextRenewal = new Date(expiresAt.getTime() - 30 * 24 * 60 * 60 * 1000);
    await saveByoDnsProviderConfig({
      ...config,
      lastCertRenewalAt: new Date().toISOString(),
      nextCertRenewalDueAt: nextRenewal.toISOString(),
    });

    return NextResponse.json({
      ok: true,
      domains: result.domains,
      expiresAt: result.expiresAt,
      nextCertRenewalDueAt: nextRenewal.toISOString(),
    });
  } catch (error) {
    console.error('[tls/acme/provider] failed:', error);
    const status = error instanceof Error && error.message.includes('timed out') ? 504 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Certificate issuance failed' },
      { status },
    );
  }
}
