/**
 * SSO Setup API
 *
 * POST /api/auth/sso/setup — Execute SSO setup (create Authentik provider, application, configure env)
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { checkSSOPrerequisites, setupSSO } from '@/lib/auth/sso-setup';

export async function POST() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // Verify prerequisites
    const status = await checkSSOPrerequisites();

    if (!status.domain) {
      return NextResponse.json({ error: 'Domain not configured' }, { status: 400 });
    }
    if (!status.authentikSubdomain) {
      return NextResponse.json({ error: 'Authentik subdomain not configured in Caddy' }, { status: 400 });
    }
    if (!status.controlSubdomain) {
      return NextResponse.json({ error: 'Control Panel subdomain not configured in Caddy' }, { status: 400 });
    }
    if (!status.authentikHealthy) {
      return NextResponse.json({ error: 'Authentik is not responding' }, { status: 400 });
    }

    // Execute setup
    const result = await setupSSO({
      authentikExternalUrl: `https://${status.authentikSubdomain}`,
      controlExternalUrl: `https://${status.controlSubdomain}`,
    });

    return NextResponse.json({
      status: 'success',
      message: 'SSO configured successfully. Control Panel is restarting...',
      clientId: result.clientId,
    });
  } catch (error) {
    console.error('SSO setup failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'SSO setup failed' },
      { status: 500 }
    );
  }
}
