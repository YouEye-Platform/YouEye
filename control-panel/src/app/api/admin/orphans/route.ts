/**
 * Orphan resource detection and cleanup API (admins and the CLI only).
 *
 * GET  /api/admin/orphans — detect orphaned resources
 * POST /api/admin/orphans — clean up orphaned resources
 *   Body: { action: 'cleanup-all' } or { action: 'cleanup', orphan: OrphanResource }
 */

import { NextRequest, NextResponse } from 'next/server';
import { detectOrphans, cleanupOrphan, cleanupAllOrphans } from '@/lib/market/orphan-detector';
import type { OrphanResource } from '@/lib/market/types';
import { requireAdmin, requireAdminCsrf } from '@/lib/auth/rbac';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const orphans = await detectOrphans();
    return NextResponse.json({ orphans, count: orphans.length });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to detect orphans: ${err}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;
  let body: { action: string; orphan?: OrphanResource };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'cleanup-all') {
    try {
      const result = await cleanupAllOrphans();
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json(
        { error: `Cleanup failed: ${err}` },
        { status: 500 }
      );
    }
  }

  if (body.action === 'cleanup' && body.orphan) {
    try {
      const result = await cleanupOrphan(body.orphan);
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json(
        { error: `Cleanup failed: ${err}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json(
    { error: 'Invalid action. Use "cleanup-all" or "cleanup" with an orphan object.' },
    { status: 400 }
  );
}
