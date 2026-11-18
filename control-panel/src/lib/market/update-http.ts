/**
 * Authenticated Market update endpoint. Retains the CLI's SSE response format.
 * Durable admission in updateMarketApp is authoritative across processes.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { updateMarketApp } from '@/lib/market/updater';
import { getAppUpdateOperation } from '@/lib/market/update-operations';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { isLifecycleBusy } from '@/lib/http/lifecycle-busy';

const COMMITTED_PENDING = 'The new version is installed, but the app is still in maintenance: reopening it did not '
  + 'finish. Retry recovery (youeye app recover <app>); the cause is in the Control Panel journal.';

const COMMITTED_CLEANUP_PENDING = 'The new version is installed and the app is open; removing the update\'s '
  + 'recovery points did not finish. Retry recovery; the cause is in the Control Panel journal.';

const ROLLED_BACK = 'The update failed and was rolled back: the app runs its previous version. The cause is in the '
  + 'Control Panel journal.';

function completedMessage(sharedFolders: string[] | undefined): string {
  return sharedFolders?.length
    ? `Update complete. Shared folders (${sharedFolders.join(', ')}) are used in place and never rolled back.`
    : 'Update complete';
}

function publicUpdateFailure(code: unknown): string {
  if (code === 'unsupported-shared-resource') return 'Update blocked: app storage or its database has writers outside this app.';
  if (code === 'insufficient-recovery-capacity') return 'Update blocked: insufficient space for recovery checkpoints and cleanup.';
  if (code === 'foreign-or-missing-container') return 'Update blocked: an app container has a network interface or owner the update cannot verify (see the Control Panel journal).';
  if (code === 'foreign-volume' || code === 'unknown-mutable-volume') return 'Update blocked: app storage ownership could not be verified.';
  if (code === 'unknown-security-state') return 'Update blocked: the app\'s security files could not be read safely (see the Control Panel journal).';
  if (code === 'old-runtime-unavailable') return 'Update blocked: the previous runtime is unavailable for recovery.';
  if (code === 'operation_in_progress') return 'Another update or operation is in progress; try again in a moment.';
  if (code === 'committed-reopen-pending') return COMMITTED_PENDING;
  if (code === 'committed-post-update-failed') return 'The new version is installed and the app is open, but a step after the update failed; the cause is in the Control Panel journal.';
  if (code === 'own-postgres-update-unsupported') return 'Update not possible in place: this app\'s own PostgreSQL (a superuser login or extensions) can\'t be checkpointed yet. Nothing was changed.';
  if (code === 'connection-interface-missing') return 'Update blocked: a connection of this app lost its network interface. Re-activate the connection, then update.';
  return 'Update failed. Check the operation status.';
}

export async function handleMarketUpdate(req: NextRequest, routeAppId?: string, format: 'sse' | 'json' = 'sse') {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  // The verifier also supports authenticated CLI credentials without a cookie.
  if (!(await verifyCSRFToken(req.headers.get('X-CSRF-Token') || ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const parsed = await req.json().catch(() => routeAppId ? {} : null);
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...parsed, ...(routeAppId ? { appId: routeAppId } : {}) } : null;
  if (!body || typeof body.appId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.appId)) {
    return NextResponse.json({ error: 'Invalid update request' }, { status: 400 });
  }
  const appId: string = body.appId;
  try {
    if (getAppUpdateOperation(appId)?.pending) {
      return NextResponse.json({
        error: 'An update is pending. Check its status or retry recovery.',
        code: 'operation_pending',
      }, { status: 409 });
    }
    if (!(await getInstalledApp(appId))) {
      return NextResponse.json({ error: 'Installed app not found' }, { status: 404 });
    }
  } catch (error) {
    logOperationFailure(`Reading the update status of ${appId}`, error);
    return NextResponse.json({ error: 'Update status is unavailable' }, { status: 503 });
  }

  if (format === 'json') {
    try {
      const result = await withUserOperationLockWait(() => updateMarketApp({ appId }, () => {}));
      const operation = getAppUpdateOperation(appId);
      if (operation?.pending) {
        return NextResponse.json({ status: 'pending', code: 'operation_pending',
          message: operation.committed ? (operation.reopened ? COMMITTED_CLEANUP_PENDING : COMMITTED_PENDING)
            : 'Update pending. Check its status or retry recovery.' }, { status: 409 });
      }
      if (!result.success) console.error(`[Market] Update of ${appId} did not succeed: ${result.errorCode ?? 'no code'}: ${result.error ?? ''}`);
      return NextResponse.json({ status: result.success ? 'success' : 'error',
        message: result.success ? completedMessage(result.sharedFolders)
          : operation?.rolledBack && operation.id === result.operationId ? ROLLED_BACK : publicUpdateFailure(result.errorCode),
        previous_version: result.previousVersion, new_version: result.newVersion },
        { status: result.success ? 200 : result.errorCode === 'operation_in_progress' ? 409 : 500 });
    } catch (error) {
      logOperationFailure(`Update of ${appId}`, error);
      const code = isLifecycleBusy(error) ? 'operation_in_progress'
        : error && typeof error === 'object' && 'code' in error ? error.code : null;
      return NextResponse.json({ status: 'error', code: code ?? undefined, message: publicUpdateFailure(code) },
        { status: code === 'operation_in_progress' ? 409 : 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (stage: string, message: string, progress?: number) => {
        try {
          controller.enqueue(encoder.encode(
            `event: update\ndata: ${JSON.stringify({ stage, message, progress })}\n\n`,
          ));
        } catch { /* The durable operation continues after a client disconnect. */ }
      };
      try {
        const result = await withUserOperationLockWait(() => updateMarketApp(
          { appId },
          (event) => {
            // Provider messages can contain command output, paths or secrets.
            emit('rebuilding', 'Updating application...', event.totalSteps > 0
              ? Math.max(0, Math.min(99, Math.round(event.step / event.totalSteps * 100)))
              : 0);
          },
        ));
        const operation = getAppUpdateOperation(appId);
        if (operation?.pending) {
          emit('pending', operation.committed
            ? (operation.reopened ? COMMITTED_CLEANUP_PENDING : COMMITTED_PENDING)
            : 'Update pending. Check its status or retry recovery.');
        } else {
          if (!result.success) console.error(`[Market] Update of ${appId} did not succeed: ${result.errorCode ?? 'no code'}: ${result.error ?? ''}`);
          emit(result.success ? 'completed' : 'failed',
            result.success ? completedMessage(result.sharedFolders)
              : operation?.rolledBack && operation.id === result.operationId ? ROLLED_BACK : publicUpdateFailure(result.errorCode), 100);
        }
      } catch (error) {
        logOperationFailure(`Update of ${appId}`, error);
        // Only known public codes select copy; never serialize an exception.
        const code = isLifecycleBusy(error) ? 'operation_in_progress'
          : error && typeof error === 'object' && 'code' in error ? error.code : null;
        emit('failed', publicUpdateFailure(code));
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}
