/**
 * Check All Updates
 *
 * POST /api/apps/check-updates
 *
 * Triggers a fresh digest check for all OCI apps. Returns a summary.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { refreshAllUpdates, getLastCheckedAt } from '@/lib/apps/update-cache';

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const results = await refreshAllUpdates();
    const updates: Record<string, { hasUpdate: boolean; error?: string }> = {};
    for (const [id, r] of results) {
      updates[id] = { hasUpdate: r.hasUpdate, error: r.error };
    }

    return NextResponse.json({
      updates,
      checkedAt: getLastCheckedAt(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Check failed' },
      { status: 502 }
    );
  }
}
