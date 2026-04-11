import { NextResponse } from 'next/server';
import { getUnifiedStatuses } from '@/lib/updates/state';

/**
 * GET /api/updates/status
 * Returns all active update statuses (aggregated from Spine + DB).
 */
export async function GET() {
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
