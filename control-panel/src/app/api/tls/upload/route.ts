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
import { withTlsMutation } from '@/lib/acme/mutation';
import { validateUploadedCertificate } from '@/lib/acme/upload-validation';
import { settingsService } from '@/lib/settings';
import { applyUploadedCertificateWithRecovery } from '@/lib/acme/upload-activation';

/** Basic PEM format validation */
function isPem(str: string, type: string): boolean {
  return str.includes(`-----BEGIN ${type}-----`) && str.includes(`-----END ${type}-----`);
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

    if (chain !== undefined && typeof chain !== 'string') {
      return NextResponse.json({ error: 'Certificate chain must be PEM text.' }, { status: 400 });
    }
    return await withTlsMutation(session.authMethod, async () => {
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

    let validated: ReturnType<typeof validateUploadedCertificate>;
    try { validated = validateUploadedCertificate({ certificate: fullCert, privateKey, domains }); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid certificate material.' }, { status: 400 }); }

    const previousSettings = await settingsService.getRaw() as Record<string, unknown>;
    const previousCertificate = await tlsStorage.getCert();
    if (['manual', 'acme'].includes(String(previousSettings.tls_mode)) && !previousCertificate) {
      throw new Error('Current TLS state cannot be read safely.');
    }
    const previousProxy = await caddy.getConfig();
    const outcome = await applyUploadedCertificateWithRecovery({
    persist: () => tlsStorage.storeCert({
      mode: 'manual',
      certPem: validated.certificate,
      keyPem: validated.privateKey,
      issuer: 'Custom',
      domains: validated.domains,
      expiresAt: validated.expiresAt,
      issuedAt: validated.issuedAt,
    }),

    // Load into Caddy
    activate: () => caddy.loadExternalCert(validated.certificate, validated.privateKey, validated.domains),
    restoreProxy: () => caddy.setConfig(previousProxy),
    restoreStorage: async () => {
        if (previousCertificate) await tlsStorage.storeCert(previousCertificate);
        else await tlsStorage.revertToInternal();
    },
    });
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.recovered
        ? 'The certificate could not be applied. The previous TLS configuration was restored.'
        : 'Certificate activation and recovery could not be confirmed. Reconcile TLS before retrying.' }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      domains,
      message: 'Custom certificate uploaded and applied.',
    });
    });
  } catch {
    console.error('[TLS/Upload] Certificate activation failed');
    return NextResponse.json(
      { error: 'Certificate activation could not be confirmed. Reconcile the current TLS state before retrying.' },
      { status: 500 },
    );
  }
}
