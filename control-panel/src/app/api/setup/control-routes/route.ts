/**
 * Root Control Routes Repair API
 *
 * Reapplies the root-domain Control Panel surfaces after an update or
 * reconfiguration. This keeps existing installs aligned with fresh setup.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { settingsService } from '@/lib/settings';
import {
  checkHealth,
  ensureControlSettingsRoute,
  getConfiguredDomain,
} from '@/lib/caddy/client';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    if (session.username !== 'cli') {
      const csrfToken = request.headers.get('X-CSRF-Token');
      if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
        return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
      }
    }

    const healthy = await checkHealth();
    if (!healthy) {
      return NextResponse.json(
        { error: 'Caddy is not running. Install and start Caddy first.' },
        { status: 503 }
      );
    }

    const settings = await settingsService.getRaw();
    const domain = settings.domain || (await getConfiguredDomain());
    if (!domain) {
      return NextResponse.json(
        { error: 'No configured domain found' },
        { status: 400 }
      );
    }

    await ensureControlSettingsRoute(domain, 'youeye-control', 3000);

    return NextResponse.json({
      success: true,
      domain,
      routes: ['/settings', '/market'],
    });
  } catch (error) {
    console.error('[Setup/ControlRoutes] Failed to repair root control routes:', error);
    return NextResponse.json(
      {
        error: 'Failed to repair root control routes',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
