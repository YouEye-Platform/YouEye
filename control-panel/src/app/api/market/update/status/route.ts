import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { getAppDefinition } from '@/lib/apps/definitions';
import { getAppUpdateOperation } from '@/lib/market/update-operations';
import { getMarketUpdateResult, getMarketUpdateResults, isMarketUpdateRunning } from '@/lib/market/update-http';

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
      reopened: operation.reopened,
      errorCode: operation.errorCode && /^[a-z0-9_-]{1,80}$/.test(operation.errorCode)
        ? operation.errorCode : null,
    } : null,
    // Updated by the Market updater (and so recorded here), not a built-in app's own updater.
    market: !getAppDefinition(appId),
    // The last update's own outcome in this Control Panel run, and whether one is still on its way to it.
    result: getMarketUpdateResult(appId),
    results: getMarketUpdateResults(appId),
    running: isMarketUpdateRunning(appId),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Update status is unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
