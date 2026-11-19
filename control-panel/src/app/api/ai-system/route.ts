import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { POINTER_MANAGEMENT_BASE } from '@/lib/pointer/client';
import { installedPointerVersion } from '@/lib/pointer/release-metadata';

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const health = await fetch(`${POINTER_MANAGEMENT_BASE}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    const body = await health.json() as { status?: string; surface?: string; build?: { version?: string }; checks?: Array<{ code?: string; status?: string }> };
    const schema = body.checks?.find((check) => check.code === 'schema');
    // The installed release's version; Pointer's own (baked) version only when no release is recorded.
    const version = await installedPointerVersion() ?? body.build?.version ?? null;
    return NextResponse.json({
      status: body.status === 'ready' || body.status === 'ok'
        ? 'ready'
        : body.status === 'degraded' ? 'degraded' : 'unhealthy',
      version,
      surface: body.surface ?? 'management',
      database: schema?.status === 'ok' ? 'current' : 'check_failed',
      backup: 'included_in_core_backup',
    }, { status: health.ok ? 200 : 503 });
  } catch {
    return NextResponse.json({
      status: 'unavailable', version: null, database: 'unknown', backup: 'included_in_core_backup',
    }, { status: 503 });
  }
}
