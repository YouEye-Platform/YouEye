/**
 * Unified Market uninstall API.
 * Removes an installed app (Market-installed or native) and all its resources.
 *
 * POST /api/market/uninstall
 * Body: { appId, keepData?: boolean }
 *
 * keepData = true (default): removes container, Caddy route, identity provider entries, DNS
 *                              but preserves volume data for reinstall
 * keepData = false:            removes everything including data volumes and shared DB
 */

import { NextRequest, NextResponse } from 'next/server';
import { uninstallApp } from '@/lib/market/uninstaller';
import { emitEvent } from '@/lib/events/emitter';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { withUserOperationLockWait } from '@/lib/market/update-admission';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  let body: { appId?: string; keepData?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.appId) {
    return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
  }

  try {
    const keepData = body.keepData ?? true;

    // The uninstaller decides from the app's install.json (never the live catalog):
    // delete-data removes the app's own database and role, volumes, secrets and CA directory.
    const appId = body.appId;
    const result = await withUserOperationLockWait(() => uninstallApp(appId, { keepData }));
    if (!result.success) {
      logOperationFailure(`Uninstall of ${appId}`, new Error(result.errors.join('; ')));
    }
    if (result.success) {
      emitEvent('app.uninstalled', { appId: body.appId, keepData });
    }
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch (err) {
    logOperationFailure(`Uninstall of ${body.appId}`, err);
    const busy = err instanceof Error && err.name === 'AppLifecycleBusyError';
    return NextResponse.json(
      { success: false, errors: [busy ? (err as Error).message : String(err)] },
      { status: busy ? 409 : 500 }
    );
  }
}
