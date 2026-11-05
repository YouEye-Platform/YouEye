import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getUnifiedStatuses } from '@/lib/updates/state';
import { checkUpdateStatusAccess } from '@/lib/updates/status-access';

/**
 * GET /api/updates/status
 * Returns all active update statuses (aggregated from Spine + DB).
 */
export async function GET() {
  const access = checkUpdateStatusAccess(await getSession());
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  try {
    const statuses = await getUnifiedStatuses();
    return NextResponse.json({ statuses });
  } catch (error) {
    console.error('Failed to get update statuses:', error);
    return NextResponse.json(
      { error: 'Failed to get update statuses' },
      { status: 500 }
    );
  }
}
