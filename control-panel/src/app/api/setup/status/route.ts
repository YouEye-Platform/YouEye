import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getApplianceClaimStatus } from '@/lib/identity/store';
import { settingsService } from '@/lib/settings';
import { hasRetainedSetupOperation } from '@/lib/setup/lifecycle';
import { setupProgressStatus } from '@/lib/setup/progress.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  // The retained setup JWT remains valid after its operation/claim settles.
  if (!(await getSession())?.isAdmin) {
    return NextResponse.json({ error: 'Administrator access required' }, { status: 401 });
  }
  try {
    const [config, claim] = await Promise.all([settingsService.getRaw(), getApplianceClaimStatus()]);
    return NextResponse.json(setupProgressStatus(config, claim, hasRetainedSetupOperation()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Setup progress is unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
