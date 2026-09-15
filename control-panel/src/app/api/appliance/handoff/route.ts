import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { isApplianceSetupHost } from '@/lib/auth/mode';
import { getIdentityConfig } from '@/lib/identity/config';
import { createSetupHandoff, reconcileApplianceSetupComplete } from '@/lib/identity/store';
import { settingsService } from '@/lib/settings';

export async function POST(request: NextRequest) {
  const host = request.headers.get('host') || '';
  if (!isApplianceSetupHost(host)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const session = await getSession();
  if (session?.authMethod !== 'setup' || !session.setupOwnerId) {
    return NextResponse.json({ error: 'Sign in as the appliance owner to continue.' }, { status: 401 });
  }
  const csrf = request.headers.get('x-csrf-token') || '';
  if (!(await verifyCSRFToken(csrf))) {
    return NextResponse.json({ error: 'The setup session expired. Sign in again.' }, { status: 403 });
  }

  try {
    const settings = await settingsService.getRaw();
    if (!settings.setup_completed) {
      return NextResponse.json({ error: 'Server setup has not finished yet.' }, { status: 409 });
    }
    await reconcileApplianceSetupComplete();
    const config = await getIdentityConfig();
    const code = await createSetupHandoff(session.setupOwnerId, config.externalUrl);
    return NextResponse.json({
      action: `${config.externalUrl}/identity/handoff`,
      code,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[setup-handoff] Could not create handoff:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'The server address is not ready yet. Check DNS and try again.' }, { status: 503 });
  }
}
