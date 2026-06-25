/**
 * Identity Provider Settings API
 *
 * POST /api/settings/identity-provider — Update the identity provider display name.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { settingsService } from '@/lib/settings';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const identityName = body.identity_name;

  if (!identityName || typeof identityName !== 'string' || identityName.trim().length === 0) {
    return NextResponse.json({ error: 'identity_name is required' }, { status: 400 });
  }

  const raw = await settingsService.getRaw();
  const identity = raw.identity && typeof raw.identity === 'object'
    ? raw.identity as Record<string, unknown>
    : {};
  await settingsService.setRaw({
    identity: {
      ...identity,
      provider: 'youeye-id',
      name: identityName.trim(),
    },
  });

  return NextResponse.json({ success: true });
}
