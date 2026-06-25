/**
 * YouEye Names — name preview
 *
 * POST /api/tls/youeye-names/preview
 *   Body: { count?: number }  → generated options
 *      or { name?: string }   → availability of one specific name
 *
 * NON-COMMITTING: no lease, no DNS, no certificate. This backs the "refresh
 * until you like one" cycle on the setup screen. The claim + certificate only
 * happen later, during provisioning.
 *
 * Auth mirrors /api/tls/acme: admin session (the setup wizard runs inside the
 * PAM-authenticated admin session) + CSRF.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { previewName, previewNames } from '@/lib/youeye-names/client';

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

    const body = await request.json().catch(() => ({}));

    if (typeof body.name === 'string' && body.name.trim()) {
      const preview = await previewName(body.name.trim().toLowerCase());
      return NextResponse.json({ previews: preview ? [preview] : [] });
    }

    const count = Math.min(Math.max(Number(body.count) || 1, 1), 5);
    const previews = await previewNames(count);
    return NextResponse.json({ previews });
  } catch (error) {
    console.error('[TLS/YouEyeNames] preview failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not reach YouEye Names',
      },
      { status: 502 },
    );
  }
}
