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
  + 'recovery points did not finish. Retry recovery (youeye app recover <app>); the cause is in the Control Panel journal.';

const ROLLED_BACK = 'The update failed and was rolled back: the app runs its previous version. The cause is in the '
  + 'Control Panel journal.';

const RECOVERY_REQUIRED = 'The update failed and the app could not be brought back: it stays in maintenance and its '
  + 'recovery points are kept. Retry recovery (youeye app recover <app>); the cause is in the Control Panel journal.';

const SETUP_CHANGED = 'Setup steps changed: the new version of this app, added by URL, runs different setup files inside '
  + 'its containers. Nothing was changed. Update again and allow them (allowSetup; youeye app update <app> --allow-setup) '
  + 'only if you trust its publisher.';

/** What a finished update says. An app that already runs what its source offers is told so, not "Update complete". */
export function completedMessage(result: { sharedFolders?: string[]; unchanged?: boolean; newVersion?: string }): string {
  if (result.unchanged) {
    return `Already up to date${result.newVersion ? ` (version ${result.newVersion})` : ''}: nothing was changed.`;
  }
  const sharedFolders = result.sharedFolders;
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
  if (code === 'recovery_required') return RECOVERY_REQUIRED;
  if (code === 'writer-stop-timeout') return 'Update not started: a container of this app did not stop in time. Nothing was changed.';
  if (code === 'postgres-runtime-change-excluded') return 'Update not possible in place: the new version changes the app\'s own database engine. Nothing was changed.';
  if (code === 'own-database-storage-undeclared') return 'Update not possible in place: this app\'s own database does not keep its files in a declared volume of its own, so no restore point can be taken. Nothing was changed.';
  if (code === 'sql-migration-own-database-unsupported') return 'Update not possible in place: it runs an SQL migration, which an app with its own database can\'t use. Nothing was changed.';
  if (code === 'connection-interface-missing') return 'Update blocked: a connection of this app lost its network interface. Re-activate the connection, then update.';
  if (code === 'setup-changed') return SETUP_CHANGED;
  if (code === 'requires-newer-youeye') return 'Update blocked: the new version of this app needs a newer YouEye. Update YouEye in Settings, then update the app.';
  if (code === 'source-not-accepted') return 'Update blocked: this app comes from a Market source you have not accepted. Accept the source first (youeye market accept <source>).';
  if (code === 'source-unavailable') return 'Update blocked: this app\'s Market source is turned off or no longer configured. Choose a source for it on the app\'s page (or: youeye app source <app> <market id>).';
  if (code === 'source-changed') return 'Update blocked: this app\'s Market source now points at another market than the app was installed from. Switch the app to that source on its page if you want its updates from there.';
  return 'Update failed. Check the operation status.';
}

/**
 * What a failed update says. A recovery that failed comes first: the app is in maintenance, so no first failure's
 * "Nothing was changed" is true any more. Otherwise a stop that timed out names its container (the provider's own
 * message) and is not reported as a rollback: nothing was changed.
 */
export function resultFailureMessage(result: { errorCode?: string; error?: string; operationId?: string },
  operation: { rolledBack: boolean; id: string; committed?: boolean; recoveryRequired?: boolean } | null): string {
  const own = operation && operation.id === result.operationId ? operation : null;
  if (result.errorCode === 'recovery_required' || own?.recoveryRequired
    || (own && !own.rolledBack && own.committed === false)) return RECOVERY_REQUIRED;
  if (result.errorCode === 'writer-stop-timeout') {
    return result.error?.startsWith('Update not started: ') ? result.error : publicUpdateFailure(result.errorCode);
  }
  return own?.rolledBack ? ROLLED_BACK : publicUpdateFailure(result.errorCode);
}

const UPDATE_PENDING = 'Update pending. Check its status or retry recovery (youeye app recover <app>).';

/**
 * What an update says when its operation is still pending as it returns. An update that neither committed nor was
 * rolled back left the app in maintenance: that is `recovery_required`, whatever the result's own code. A committed
 * one names what did not finish; a rolled-back one only has cleanup left.
 */
export function pendingUpdateReport(operation: { committed: boolean; rolledBack: boolean; reopened?: boolean }):
  { message: string; code: 'operation_pending' | 'recovery_required' } {
  if (operation.committed) {
    return { message: operation.reopened ? COMMITTED_CLEANUP_PENDING : COMMITTED_PENDING, code: 'operation_pending' };
  }
  if (!operation.rolledBack) return { message: RECOVERY_REQUIRED, code: 'recovery_required' };
  return { message: UPDATE_PENDING, code: 'operation_pending' };
}

/** A `source-changed` refusal's own message names the market addresses (the owner's own settings); other errors get fixed copy. */
function failureMessage(code: unknown, error: unknown): string {
  return code === 'source-changed' && error instanceof Error && error.name === 'MarketSourceConsentError' ? error.message : publicUpdateFailure(code);
}

/**
 * What the last update of an app said when it returned, as its stream (or JSON answer) said it. The status endpoint
 * serves it, so a client whose stream dropped learns the update's own outcome, not only its operation record's: a
 * step after the commit can still fail, and an operation can stay pending once the update returned. In memory only:
 * a restarted Control Panel has none, and `running` tells a client that no update is still on its way to one.
 */
export interface MarketUpdateResult {
  /** The journal operation the update created; null when it ended before one (refused, already up to date). */
  operationId: string | null;
  success: boolean;
  errorCode: string | null;
  message: string;
  at: string;
}

interface MarketUpdateResults { results: Map<string, MarketUpdateResult[]>; running: Map<string, number> }

/** Results kept per app, newest last: a second update of the app must not hide the first one's from its follower. */
const KEPT_RESULTS = 5;

function marketUpdateResults(): MarketUpdateResults {
  const holder = globalThis as typeof globalThis & { [key: symbol]: MarketUpdateResults | undefined };
  const key = Symbol.for('youeye.market.update-results');
  return holder[key] ??= { results: new Map(), running: new Map() };
}

export function getMarketUpdateResult(appId: string): MarketUpdateResult | null {
  return marketUpdateResults().results.get(appId)?.at(-1) ?? null;
}

/** The app's last few update results in this Control Panel run, newest last. */
export function getMarketUpdateResults(appId: string): MarketUpdateResult[] {
  return [...(marketUpdateResults().results.get(appId) ?? [])];
}

/** Whether an update of the app is running in this Control Panel (it records its result as it returns). */
export function isMarketUpdateRunning(appId: string): boolean {
  return (marketUpdateResults().running.get(appId) ?? 0) > 0;
}

/** Marks an update of the app running; the returned finish records its result (once) and ends the mark. */
function trackMarketUpdate(appId: string): (result?: Omit<MarketUpdateResult, 'at'>) => void {
  const state = marketUpdateResults();
  state.running.set(appId, (state.running.get(appId) ?? 0) + 1);
  let finished = false;
  return (result) => {
    if (finished) return;
    finished = true;
    if (result) {
      const kept = state.results.get(appId) ?? [];
      kept.push({ ...result, message: forApp(result.message, appId),
        errorCode: result.errorCode && /^[A-Za-z0-9_-]{1,80}$/.test(result.errorCode) ? result.errorCode : null,
        at: new Date().toISOString() });
      state.results.set(appId, kept.slice(-KEPT_RESULTS));
    }
    const left = (state.running.get(appId) ?? 1) - 1;
    if (left > 0) state.running.set(appId, left); else state.running.delete(appId);
  };
}

/** Messages name the command to run with `<app>`; the app's own id goes in before a message leaves. */
function forApp(message: string, appId: string): string {
  return message.replaceAll('<app>', appId);
}

function thrownCode(error: unknown): string | null {
  return isLifecycleBusy(error) ? 'operation_in_progress'
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
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
  if (body.allowSetup !== undefined && typeof body.allowSetup !== 'boolean') {
    return NextResponse.json({ error: 'Invalid update request' }, { status: 400 });
  }
  const config = { appId, allowSetup: body.allowSetup === true };
  try {
    if (getAppUpdateOperation(appId)?.pending) {
      return NextResponse.json({
        error: `An update is pending. Check its status or retry recovery (youeye app recover ${appId}).`,
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
    const finish = trackMarketUpdate(appId);
    try {
      const result = await withUserOperationLockWait(() => updateMarketApp(config, () => {}));
      const operation = getAppUpdateOperation(appId);
      const operationId = result.operationId ?? null;
      if (operation?.pending) {
        if (!result.success) console.error(`[Market] Update of ${appId} is pending: ${result.errorCode ?? 'no code'}: ${result.error ?? ''}`);
        const report = pendingUpdateReport(operation);
        finish({ operationId, success: false, errorCode: report.code, message: report.message });
        return NextResponse.json({ status: 'pending', ...report, message: forApp(report.message, appId) }, { status: 409 });
      }
      if (!result.success) console.error(`[Market] Update of ${appId} did not succeed: ${result.errorCode ?? 'no code'}: ${result.error ?? ''}`);
      if (result.errorCode === 'setup-changed') {
        finish({ operationId, success: false, errorCode: 'setup-changed', message: SETUP_CHANGED });
        return NextResponse.json({ status: 'error', code: 'setup-changed', error: forApp(SETUP_CHANGED, appId),
          message: forApp(SETUP_CHANGED, appId),
          setups: result.setups ?? [] }, { status: 409 });
      }
      const message = result.success ? completedMessage(result) : resultFailureMessage(result, operation);
      finish({ operationId, success: result.success, errorCode: result.errorCode ?? null, message });
      return NextResponse.json({ status: result.success ? 'success' : 'error', message: forApp(message, appId),
        previous_version: result.previousVersion, new_version: result.newVersion },
        { status: result.success ? 200 : result.errorCode === 'operation_in_progress' ? 409 : 500 });
    } catch (error) {
      logOperationFailure(`Update of ${appId}`, error);
      const code = thrownCode(error);
      const message = failureMessage(code, error);
      finish({ operationId: null, success: false, errorCode: code, message });
      return NextResponse.json({ status: 'error', code: code ?? undefined, message: forApp(message, appId) },
        { status: code === 'operation_in_progress' ? 409
          : code === 'source-not-accepted' || code === 'source-unavailable' || code === 'source-changed' ? 403 : 500 });
    } finally {
      finish();
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const finish = trackMarketUpdate(appId);
      let streamedOperation: string | undefined;
      const emit = (stage: string, message: string, progress?: number, extra?: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(
            `event: update\ndata: ${JSON.stringify({ stage, message: forApp(message, appId), progress, ...extra })}\n\n`,
          ));
        } catch { /* The durable operation continues after a client disconnect. */ }
      };
      try {
        const result = await withUserOperationLockWait(() => updateMarketApp(
          config,
          (event) => {
            // While this update holds the app's lock, a pending operation of the app is this update's: its id goes
            // with the progress, so a client whose stream drops later knows which result is its own.
            if (!streamedOperation) {
              try { streamedOperation = getAppUpdateOperation(appId)?.pending ? getAppUpdateOperation(appId)?.id : undefined; }
              catch { /* the next event tries again */ }
            }
            // Provider messages can contain command output, paths or secrets.
            emit('rebuilding', 'Updating application...', event.totalSteps > 0
              ? Math.max(0, Math.min(99, Math.round(event.step / event.totalSteps * 100)))
              : 0, streamedOperation ? { operationId: streamedOperation } : undefined);
          },
        ));
        const operation = getAppUpdateOperation(appId);
        const operationId = result.operationId ?? null;
        if (operation?.pending) {
          if (!result.success) console.error(`[Market] Update of ${appId} is pending: ${result.errorCode ?? 'no code'}: ${result.error ?? ''}`);
          const { message, code } = pendingUpdateReport(operation);
          finish({ operationId, success: false, errorCode: code, message });
          emit('pending', message, undefined, code === 'recovery_required' ? { code } : undefined);
        } else {
          if (!result.success) console.error(`[Market] Update of ${appId} did not succeed: ${result.errorCode ?? 'no code'}: ${result.error ?? ''}`);
          if (result.errorCode === 'setup-changed') {
            finish({ operationId, success: false, errorCode: 'setup-changed', message: SETUP_CHANGED });
            emit('failed', SETUP_CHANGED, 100, { code: 'setup-changed', setups: result.setups ?? [] });
            return;
          }
          const message = result.success ? completedMessage(result) : resultFailureMessage(result, operation);
          finish({ operationId, success: result.success, errorCode: result.errorCode ?? null, message });
          emit(result.success ? 'completed' : 'failed', message, 100);
        }
      } catch (error) {
        logOperationFailure(`Update of ${appId}`, error);
        // Only known public codes select copy; never serialize an exception.
        const code = thrownCode(error);
        const message = failureMessage(code, error);
        finish({ operationId: null, success: false, errorCode: code, message });
        emit('failed', message, undefined, code === 'source-changed' ? { code } : undefined);
      } finally {
        finish();
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
