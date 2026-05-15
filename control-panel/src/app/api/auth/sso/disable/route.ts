/**
 * SSO Disable API
 *
 * POST /api/auth/sso/disable — Disable SSO (remove Authentik provider, application, clear env)
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { disableSSO } from '@/lib/auth/sso-setup';

export async function POST() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    await disableSSO();

    return NextResponse.json({
      status: 'success',
      message: 'SSO disabled. Control Panel is restarting...',
    });
  } catch (error) {
    console.error('SSO disable failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to disable SSO' },
      { status: 500 }
    );
  }
}
