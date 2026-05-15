/**
 * ACME DNS-01 Challenge API
 *
 * POST /api/tls/acme — Start order: returns DNS TXT records to create
 *   Body: { domain: string, includeWildcard?: boolean }
 *
 * PUT /api/tls/acme — Verify & finalize: completes challenge, returns cert
 *   Body: { orderId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { startOrder, verifyAndFinalize } from '@/lib/acme/client';
import * as caddy from '@/lib/caddy/client';

/** Reject with timeout after ms — safety net around ACME calls */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(
        `${label} timed out after ${Math.round(ms / 1000)}s — Let's Encrypt may be slow or rate-limiting. Try again later.`
      )), ms)
    ),
  ]);
}

/**
 * POST — Start a new ACME order
 */
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
    const { domain, includeWildcard = true } = body;

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }

    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
    if (!domainRegex.test(domain)) {
      return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
    }

    console.log(`[TLS/ACME] Starting order for ${domain} (wildcard: ${includeWildcard})`);

    const result = await withTimeout(startOrder(domain, includeWildcard), 30_000, 'ACME order creation');

    return NextResponse.json({
      orderId: result.orderId,
      challenges: result.challenges,
      instructions: 'Create the DNS TXT records shown below, then call PUT /api/tls/acme to verify.',
    });
  } catch (error) {
    console.error('[TLS/ACME] Order creation failed:', error);
    const status = (error instanceof Error && error.message.includes('timed out')) ? 504 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start ACME order' },
      { status },
    );
  }
}

/**
 * PUT — Verify DNS records and finalize the certificate
 */
export async function PUT(request: NextRequest) {
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
    const { orderId } = body;

    if (!orderId || typeof orderId !== 'string') {
      return NextResponse.json({ error: 'orderId is required' }, { status: 400 });
    }

    console.log(`[TLS/ACME] Verifying order ${orderId}`);

    const result = await withTimeout(verifyAndFinalize(orderId), 60_000, 'ACME verification');

    // Load the certificate into Caddy
    await caddy.loadExternalCert(result.certificate, result.privateKey, result.domains);

    console.log(`[TLS/ACME] Certificate issued and loaded for: ${result.domains.join(', ')}`);

    return NextResponse.json({
      success: true,
      domains: result.domains,
      expiresAt: result.expiresAt,
      message: "Certificate issued and applied. Your site now uses a trusted Let's Encrypt certificate.",
    });
  } catch (error) {
    console.error('[TLS/ACME] Verification failed:', error);
    const status = (error instanceof Error && error.message.includes('timed out')) ? 504 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'ACME verification failed' },
      { status },
    );
  }
}
