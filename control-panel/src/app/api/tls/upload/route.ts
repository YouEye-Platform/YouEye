/**
 * Certificate Upload API
 *
 * POST /api/tls/upload — Upload a custom PEM certificate + private key
 *   Body: { certificate: string, privateKey: string, chain?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { tlsStorage } from '@/lib/acme/storage';
import * as caddy from '@/lib/caddy/client';

/** Basic PEM format validation */
function isPem(str: string, type: string): boolean {
  return str.includes(`-----BEGIN ${type}-----`) && str.includes(`-----END ${type}-----`);
}

/** Extract domain names from a PEM certificate's Subject/SAN (best-effort) */
function extractDomainsFromCert(certPem: string): string[] {
  // Without an ASN.1 parser, we can't reliably extract SANs from PEM.
  // Return empty — caller should provide domains or we infer from the configured domain.
  return [];
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const body = await request.json();
    const { certificate, privateKey, chain, domains: userDomains } = body;

    // Validate certificate PEM
    if (!certificate || typeof certificate !== 'string') {
      return NextResponse.json({ error: 'Certificate PEM is required' }, { status: 400 });
    }
    if (!isPem(certificate, 'CERTIFICATE')) {
      return NextResponse.json(
        { error: 'Invalid certificate format. Must be PEM-encoded (-----BEGIN CERTIFICATE-----).' },
        { status: 400 },
      );
    }

    // Validate private key PEM
    if (!privateKey || typeof privateKey !== 'string') {
      return NextResponse.json({ error: 'Private key PEM is required' }, { status: 400 });
    }
    if (!isPem(privateKey, 'PRIVATE KEY') && !isPem(privateKey, 'RSA PRIVATE KEY') && !isPem(privateKey, 'EC PRIVATE KEY')) {
      return NextResponse.json(
        { error: 'Invalid private key format. Must be PEM-encoded (-----BEGIN PRIVATE KEY-----).' },
        { status: 400 },
      );
    }

    // Combine certificate + chain if provided
    let fullCert = certificate.trim();
    if (chain && typeof chain === 'string' && chain.trim()) {
      fullCert = fullCert + '\n' + chain.trim();
    }

    // Determine domains for Caddy TLS policy
    let domains: string[] = [];
    if (Array.isArray(userDomains) && userDomains.length > 0) {
      domains = userDomains;
    } else {
      // Try to get the configured domain
      const configuredDomain = await caddy.getConfiguredDomain();
      if (configuredDomain) {
        domains = [configuredDomain, `*.${configuredDomain}`];
      }
    }

    if (domains.length === 0) {
      return NextResponse.json(
        { error: 'Could not determine certificate domains. Please provide a domains array.' },
        { status: 400 },
      );
    }

    console.log(`[TLS/Upload] Loading custom cert for: ${domains.join(', ')}`);

    // Store the certificate
    await tlsStorage.storeCert({
      mode: 'manual',
      certPem: fullCert,
      keyPem: privateKey.trim(),
      issuer: 'Custom',
      domains,
      expiresAt: '', // User should know their cert's expiry
      issuedAt: new Date().toISOString(),
    });

    // Load into Caddy
    await caddy.loadExternalCert(fullCert, privateKey.trim(), domains);

    return NextResponse.json({
      success: true,
      domains,
      message: 'Custom certificate uploaded and applied.',
    });
  } catch (error) {
    console.error('[TLS/Upload] Failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Certificate upload failed' },
      { status: 500 },
    );
  }
}
