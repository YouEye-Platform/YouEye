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

function publicUpdateFailure(code: unknown): string {
  if (code === 'unsupported-shared-resource') {
    return 'Update blocked: shared storage or a database has writers outside this app. All writers need a coordinated recovery contract.';
  }
  if (code === 'insufficient-recovery-capacity') return 'Update blocked: insufficient space for recovery checkpoints and cleanup.';
  if (code === 'foreign-volume' || code === 'unknown-mutable-volume'
    || code === 'foreign-or-missing-container') return 'Update blocked: app storage or runtime ownership could not be verified.';
  if (code === 'old-runtime-unavailable') return 'Update blocked: the previous runtime is unavailable for recovery.';
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
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.appId)
    || (body.confirm_switch !== undefined && typeof body.confirm_switch !== 'boolean')) {
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
  } catch {
    return NextResponse.json({ error: 'Update status is unavailable' }, { status: 503 });
  }

  if (format === 'json') {
    try {
      const result = await updateMarketApp({ appId, confirmSwitch: body.confirm_switch === true }, () => {});
      const operation = getAppUpdateOperation(appId);
      if (operation?.pending) {
        return NextResponse.json({ status: 'pending', code: 'operation_pending',
          message: operation.committed ? 'Update committed; cleanup requires attention. Retry recovery.'
            : 'Update pending. Check its status or retry recovery.' }, { status: 409 });
      }
      return NextResponse.json({ status: result.success ? 'success' : 'error',
        message: result.success ? 'Update complete' : publicUpdateFailure(result.errorCode),
        previous_version: result.previousVersion, new_version: result.newVersion }, { status: result.success ? 200 : 500 });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      return NextResponse.json({ status: 'error', message: publicUpdateFailure(code) }, { status: 500 });
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
        const result = await updateMarketApp(
          { appId, confirmSwitch: body.confirm_switch === true },
          (event) => {
            // Provider messages can contain command output, paths or secrets.
            emit('rebuilding', 'Updating application...', event.totalSteps > 0
              ? Math.max(0, Math.min(99, Math.round(event.step / event.totalSteps * 100)))
              : 0);
          },
        );
        const operation = getAppUpdateOperation(appId);
        if (operation?.pending) {
          emit('pending', operation.committed
            ? 'Update committed; cleanup requires attention. Retry recovery.'
            : 'Update pending. Check its status or retry recovery.');
        } else {
          emit(result.success ? 'completed' : 'failed',
            result.success ? 'Update complete' : publicUpdateFailure(result.errorCode), 100);
        }
      } catch (error) {
        // Only known public codes select copy; never serialize an exception.
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
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
