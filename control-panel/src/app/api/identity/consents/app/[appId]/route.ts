import { NextRequest, NextResponse } from 'next/server';
import { getIdentitySession } from '@/lib/identity/http';
import { getSession } from '@/lib/auth/session';
import { getAppConsent, getUserByUsername, revokeAppConsent, type IdentityUser } from '@/lib/identity/store';

function clientIdForApp(appId: string): string {
  return appId.startsWith('youeye-app-') ? appId : `youeye-app-${appId}`;
}

function permissionRow(appId: string, consent: Awaited<ReturnType<typeof getAppConsent>>) {
  if (!consent) return [];
  return [{
    id: `identity-consent:${consent.client_id}`,
    appId,
    permission: 'identity:youeye-id:sign-in',
    descriptor: {
      permission: 'identity:youeye-id:sign-in',
      title: 'Sign in with YouEye ID',
      description: 'Lets this app use your YouEye ID profile to sign you in.',
      category: 'identity',
      risk: 'low',
    },
    granted: true,
    grantType: 'first-launch',
    grantedAt: consent.granted_at,
    scopes: consent.scopes,
  }];
}

async function getConsentUser(request: NextRequest): Promise<IdentityUser | null> {
  const identityUser = await getIdentitySession(request);
  if (identityUser) return identityUser;

  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') return null;
  return getUserByUsername(session.username);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const user = await getConsentUser(_request);
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
  const user = await getConsentUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { appId } = await params;
  await revokeAppConsent(user.id, clientIdForApp(appId));
  return NextResponse.json({ success: true });
}
