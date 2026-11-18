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

  let body: { appId?: string; keepData?: boolean; force?: boolean };
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
    if (body.force === true) {
      // For what the normal removal refuses (a broken install record or ownership data): remove what carries this
      // app's id and recorded installation id, and report exactly what was and wasn't removed.
      // Only for a broken or unfinished install: an intact app goes through the normal removal, which keeps its
      // ownership checks and the retained-data path.
      if (!(await forceRemovalApplies(appId))) {
        return NextResponse.json({ success: false, errors: [
          `${appId} is installed and intact; remove it without --force (youeye app remove ${appId}).`] }, { status: 409 });
      }
      const { cleanupAppByScan } = await import('@/lib/market/reconciler');
      const cleaned = await withUserOperationLockWait(() => cleanupAppByScan(appId, { keepData, force: true }));
      if (cleaned.unresolved.length) logOperationFailure(`Forced removal of ${appId}`, new Error(cleaned.unresolved.join('; ')));
      return NextResponse.json({ success: cleaned.unresolved.length === 0, removed: cleaned.repaired, errors: cleaned.unresolved },
        { status: cleaned.unresolved.length === 0 ? 200 : 409 });
    }
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

/** An unfinished install, a removal left half-done, or a recorded container that no longer exists. */
async function forceRemovalApplies(appId: string): Promise<boolean> {
  const { readInstallMetadata } = await import('@/lib/market/metadata');
  const meta = await readInstallMetadata(appId).catch(() => null);
  if (!meta) return true; // cleanup by scan refuses on its own without a readable record
  if (meta.lifecycleState === 'installing' || meta.cleanupPending) return true;
  const { incusRequest } = await import('@/lib/incus/server');
  const listed = await incusRequest<string[]>('GET', '/1.0/instances');
  if (listed.type === 'error' || !Array.isArray(listed.metadata)) return false;
  const present = new Set(listed.metadata.map(url => url.split('/').pop()));
  return meta.containers.some(container => !present.has(container.containerName));
}
