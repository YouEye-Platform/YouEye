import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { getAppUpdateOperation } from '@/lib/market/update-operations';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const appId = new URL(request.url).searchParams.get('appId');
  if (!appId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) {
    return NextResponse.json({ error: 'Invalid appId' }, { status: 400 });
  }
  try {
    const operation = getAppUpdateOperation(appId);
    // Explicit projection keeps future journal additions out of the API.
    return NextResponse.json({ operation: operation ? {
      id: operation.id,
      phase: operation.phase,
      committed: operation.committed,
      rolledBack: operation.rolledBack,
      cleanupComplete: operation.cleanupComplete,
      recoveryRequired: operation.recoveryRequired,
      pending: operation.pending,
      errorCode: operation.errorCode && /^[a-z0-9_-]{1,80}$/.test(operation.errorCode)
        ? operation.errorCode : null,
    } : null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Update status is unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
