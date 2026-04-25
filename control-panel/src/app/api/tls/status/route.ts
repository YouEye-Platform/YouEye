/**
 * TLS Status API
 *
 * GET /api/tls/status — Current TLS mode, cert info, expiry
 *
 * DELETE /api/tls/status — Revert to self-signed (internal CA)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { tlsStorage } from '@/lib/acme/storage';
import * as caddy from '@/lib/caddy/client';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const mode = await tlsStorage.getMode();
    const stored = await tlsStorage.getCert();

    // Check cert expiry warning (14 days)
    let expiryWarning = false;
    if (stored?.expiresAt) {
      const expiry = new Date(stored.expiresAt);
      const now = new Date();
      const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      expiryWarning = daysLeft <= 14;
    }

    // Get Caddy TLS subjects
    let subjects: string[] = [];
    try {
      const config = await caddy.getConfig();
      const policies = config.apps?.tls?.automation?.policies || [];
      for (const policy of policies) {
        if (policy.subjects) {
          subjects.push(...policy.subjects);
        }
      }
      subjects = [...new Set(subjects)];
    } catch { /* ignore */ }

    return NextResponse.json({
      mode,
      hasExternalCert: !!stored,
      cert: stored
        ? {
            issuer: stored.issuer,
            domains: stored.domains,
            expiresAt: stored.expiresAt,
            issuedAt: stored.issuedAt,
          }
        : null,
      subjects,
      expiryWarning,
    });
  } catch (error) {
    console.error('[TLS/Status] Failed:', error);
    return NextResponse.json(
      { error: 'Failed to get TLS status' },
      { status: 500 },
    );
  }
}

/**
 * DELETE — Revert to self-signed certificates
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    console.log('[TLS] Reverting to self-signed certificates');

    // Remove external cert from Caddy
    await caddy.removeExternalCert();

    // Clear stored cert data
    await tlsStorage.revertToInternal();

    return NextResponse.json({
      success: true,
      message: 'Reverted to self-signed certificates. Browser trust warnings will return.',
    });
  } catch (error) {
    console.error('[TLS] Revert failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to revert TLS' },
      { status: 500 },
    );
  }
}
