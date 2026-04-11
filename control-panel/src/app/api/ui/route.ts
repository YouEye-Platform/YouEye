/**
 * UI Management API
 *
 * GET  /api/ui - Get UI status
 * POST /api/ui - Enable UI (create SSO, configure Caddy, start service)
 * DELETE /api/ui - Disable UI (remove SSO, stop service, remove Caddy route)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getUIStatus, enableUI, disableUI, ensureUIDatabase } from '@/lib/ui/manager';

/**
 * GET /api/ui - Get UI installation and service status
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const status = await getUIStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error('Error getting UI status:', error);
    return NextResponse.json(
      { error: 'Failed to get UI status', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ui - Enable the YouEye UI
 * 
 * Body: { domain: string }
 * 
 * This will:
 * 1. Ensure the youeye_ui database exists
 * 2. Create OAuth2 provider + application in Authentik
 * 3. Configure Caddy route for the UI subdomain
 * 4. Set environment variables in UI container
 * 5. Start the UI service
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const body = await request.json();
    const { domain } = body;

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'Domain is required (e.g., youeye.local)' }, { status: 400 });
    }

    // Get the current SSO config to find authentik external URL
    const { checkSSOPrerequisites } = await import('@/lib/auth/sso-setup');
    const prereqs = await checkSSOPrerequisites();

    if (!prereqs.ssoConfigured || !prereqs.authentikUrl) {
      return NextResponse.json(
        { error: 'SSO must be configured for Control Panel first. Set up SSO in Settings before enabling UI.' },
        { status: 400 }
      );
    }

    console.log(`[UI] Enabling UI at domain: ${domain} by ${session.username}`);

    // Step 1: Ensure database exists
    try {
      await ensureUIDatabase();
      console.log('[UI] Database youeye_ui ensured');
    } catch (e) {
      console.error('[UI] Failed to ensure database:', e);
      return NextResponse.json(
        { error: 'Failed to create UI database', details: e instanceof Error ? e.message : 'Unknown error' },
        { status: 500 }
      );
    }

    // Step 2-5: Enable UI (Authentik, Caddy, Spine)
    const result = await enableUI({
      domain,
      authentikExternalUrl: prereqs.authentikUrl,
    });

    return NextResponse.json({
      success: result.success,
      message: result.message,
      domain,
    });
  } catch (error) {
    console.error('Error enabling UI:', error);
    return NextResponse.json(
      { error: 'Failed to enable UI', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/ui - Disable the YouEye UI
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    console.log(`[UI] Disabling UI by ${session.username}`);

    await disableUI();

    return NextResponse.json({
      success: true,
      message: 'UI has been disabled',
    });
  } catch (error) {
    console.error('Error disabling UI:', error);
    return NextResponse.json(
      { error: 'Failed to disable UI', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
