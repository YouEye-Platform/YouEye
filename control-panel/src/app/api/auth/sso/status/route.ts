/**
 * SSO Status & Prerequisites API
 *
 * GET /api/auth/sso/status — Check SSO configuration state and prerequisites
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { checkSSOPrerequisites } from '@/lib/auth/sso-setup';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const status = await checkSSOPrerequisites();

    const allPrereqs = !!(
      status.domain &&
      status.authentikSubdomain &&
      status.controlSubdomain &&
      status.authentikHealthy
    );

    return NextResponse.json({
      ...status,
      prerequisitesMet: allPrereqs,
    });
  } catch (error) {
    console.error('SSO status check failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to check SSO status' },
      { status: 500 }
    );
  }
}
