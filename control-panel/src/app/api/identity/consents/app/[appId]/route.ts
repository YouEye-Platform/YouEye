import { NextRequest, NextResponse } from 'next/server';
import { getIdentitySession } from '@/lib/identity/http';
import { getAppConsent, revokeAppConsent } from '@/lib/identity/store';

function clientIdForApp(appId: string): string {
  return appId.startsWith('youeye-app-') ? appId : `youeye-app-${appId}`;
}

function permissionRow(appId: string, consent: Awaited<ReturnType<typeof getAppConsent>>) {
  if (!consent) return [];
  return [{
    id: `identity-consent:${consent.client_id}`,
    appId,
    permission: 'identity:youeye-id:sign-in',
    granted: true,
    grantType: 'first-launch',
    grantedAt: consent.granted_at,
    scopes: consent.scopes,
  }];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const user = await getIdentitySession(_request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { appId } = await params;
  const consent = await getAppConsent(user.id, clientIdForApp(appId));
  return NextResponse.json({ app_id: appId, permissions: permissionRow(appId, consent) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const user = await getIdentitySession(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { appId } = await params;
  await revokeAppConsent(user.id, clientIdForApp(appId));
  return NextResponse.json({ success: true });
}
