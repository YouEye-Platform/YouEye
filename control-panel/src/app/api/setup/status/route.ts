import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getApplianceClaimStatus } from '@/lib/identity/store';
import { spineClient } from '@/lib/spine/client';
import { hasRetainedSetupOperation } from '@/lib/setup/lifecycle';
import { setupProgressStatus } from '@/lib/setup/progress.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  // The retained setup JWT remains valid after its operation/claim settles.
  if (!(await getSession())?.isAdmin) {
    return NextResponse.json({ error: 'Administrator access required' }, { status: 401 });
  }
  try {
    // Completion evidence must include fresh retained steps, which the typed
    // settings cache does not preserve when reconstructing a raw response.
    const [config, claim] = await Promise.all([spineClient.getConfig(), getApplianceClaimStatus()]);
    return NextResponse.json(setupProgressStatus(config, claim, hasRetainedSetupOperation()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Setup progress is unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
