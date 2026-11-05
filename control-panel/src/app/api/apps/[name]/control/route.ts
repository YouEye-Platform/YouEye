/**
 * App Control API
 *
 * Persists user app desired state and starts/stops all app-owned containers.
 * Shared platform services are intentionally not controlled here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { controlInstalledApp, type AppPowerAction } from '@/lib/apps/lifecycle';
import type { AppControlRequest } from '@/types/apps';

const ACTIONS = new Set<AppPowerAction>(['start', 'stop', 'restart', 'status']);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!(await verifyCSRFToken(csrfToken ?? ''))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { name } = await params;
    const body: AppControlRequest = await request.json().catch(() => ({ action: 'status' }));
    const action = body.action as AppPowerAction;
    if (!ACTIONS.has(action)) {
      return NextResponse.json({ error: `Invalid action: ${body.action}` }, { status: 400 });
    }

    const result = await controlInstalledApp(
      name,
      action,
      session.username || session.authMethod || 'admin',
      { force: body.force === true },
    );

    return NextResponse.json(result, { status: result.success ? 200 : 207 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unknown installed app') ? 404 : 500;
    console.error('[app-control] Failed to control app:', error);
    return NextResponse.json({ error: message }, { status });
  }
}
