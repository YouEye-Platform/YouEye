import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import {
  SpineAPIError,
  spineClient,
  type ApplianceSystemUpdateSelection,
} from '@/lib/spine/client';
import { saveSystemUpdateSelection } from '@/lib/appliance/system-update-source';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const { action } = await params;
  if (!['check', 'stage', 'activate'].includes(action)) {
    return NextResponse.json({ error: 'Unknown system update action.' }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (action === 'activate') {
      return NextResponse.json(await spineClient.activateApplianceSystemUpdate(body.reboot === true));
    }
    const selection = body as ApplianceSystemUpdateSelection;
    const persisted = await saveSystemUpdateSelection(selection);
    const effective = selection.replace_failed === true
      ? { ...persisted, replace_failed: true }
      : persisted;
    const status = action === 'check'
      ? await spineClient.checkApplianceSystemUpdate(effective)
      : await spineClient.stageApplianceSystemUpdate(effective);
    return NextResponse.json(status);
  } catch (error) {
    if (error instanceof SpineAPIError) {
      return NextResponse.json(error.response ?? { error: error.message, code: error.code }, { status: error.statusCode });
    }
    console.error(`[system-update] ${action} failed:`, error);
    return NextResponse.json({ error: `System update ${action} failed.` }, { status: 503 });
  }
}
