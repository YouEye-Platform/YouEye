import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { resolveSystemImageOverrides } from '@/lib/infrastructure/system-market-manifests';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  try {
    const systems = await resolveSystemImageOverrides();
    return NextResponse.json({
      systems,
      managedBy: 'control-panel',
      source: 'market-system-manifests',
    });
  } catch (error) {
    console.error('[infrastructure/system-manifests] failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve Market system manifests' },
      { status: 500 }
    );
  }
}
