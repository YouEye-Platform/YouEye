import { NextRequest } from 'next/server';
import { holdPlatformLifecycle, withUserOperationLockWait, type PlatformLifecycleHold } from '@/lib/market/update-admission';
import { isLifecycleBusy } from '@/lib/http/lifecycle-busy';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { fullRestore, holdRestoreServices, restoreApps, rollBackRestore } from '@/lib/backup/full-restore';
import {
  backupSetPath,
  readRestoreStatus,
  recoveryImportErrorMessage,
  validateBackupPassphrase,
  validateRestoreOperationId,
  withRestoreLock,
  writeRestoreStatus,
  type RestoreStatusRecord,
  createPlatformBackup,
  preservePreRestoreBackup,
  type BackupSetRecord,
} from '@/lib/backup/platform-backup';
import { spineClient } from '@/lib/spine/client';
import type { BackupEvent, FullRestoreProgress } from '@/lib/backup/types';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { rm } from 'node:fs/promises';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return new Response('Admin access required', { status: 403 });
  let operationId: string;
  try {
    operationId = validateRestoreOperationId(request.nextUrl.searchParams.get('operationId'));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Invalid restore status request', { status: 400 });
  }
  const status = await readRestoreStatus(operationId);
  if (!status) return new Response('Restore operation not found', { status: 404 });
  return Response.json(status, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return new Response('Admin access required', { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }
  // The platform lifecycle is held from here until the restore and its rollback have ended, as an install holds it:
  // the recovery point is first imported from the drive, before the restore takes the backup operation lock, and
  // Spine's Control Panel restart (which waits for either lock) must not stop the Control Panel under that import.
  // Everything below runs inside the hold; the restore's own lifecycle locks reuse it.
  let hold: PlatformLifecycleHold;
  try {
    hold = await withUserOperationLockWait(() => holdPlatformLifecycle());
  } catch (error) {
    logOperationFailure('Admitting a restore', error);
    if (isLifecycleBusy(error)) return new Response('Another operation is in progress. Try again in a moment.', { status: 409 });
    // A System update, its recovery or an independent copy owns the platform: its own reason, which names no secret.
    if (error instanceof Error && error.name === 'AppLifecycleAdmissionError') return new Response(error.message, { status: 409 });
    return new Response('The restore could not start; the cause is in the Control Panel journal.', { status: 500 });
  }
  let streaming = false;
  try {
    return await hold.run(() => admittedRestore(request, hold, () => { streaming = true; }));
  } finally {
    if (!streaming) hold.release();
  }
}

/** The restore request under its platform lifecycle hold; `streaming` hands the hold to the restore's stream. */
async function admittedRestore(request: NextRequest, hold: PlatformLifecycleHold, streaming: () => void): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.backupId !== 'string' || typeof body.mediaId !== 'string' || body.confirm !== true) {
	return new Response('A confirmed backup drive and recovery point are required', { status: 400 });
  }
  let passphrase: string;
  let backupPath = '';
  let operationId: string;
  try {
    passphrase = validateBackupPassphrase(body.passphrase);
    operationId = validateRestoreOperationId(body.operationId);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Invalid restore request', { status: 400 });
  }
  const catalog = await spineClient.getExternalRecoveryPoints(body.mediaId).catch(() => ({ recovery_points: [] }));
  const point = catalog.recovery_points.find(item => item.backup_id === body.backupId);
  if (!point) return new Response('Completed backup not found on the selected drive', { status: 404 });
  try {
    const imported = await spineClient.importBackupSet({ media_id: body.mediaId, backup_id: body.backupId, passphrase });
    backupPath = imported.backup_path;
  } catch (error) {
    return new Response(recoveryImportErrorMessage(error), { status: 400 });
  }
  const record = { schema: 'youeye.backup.set.v1' as const, id: point.backup_id, createdAt: point.created_at, completedAt: point.created_at, status: 'completed' as const, appCount: point.apps.length, apps: point.apps, mediaId: body.mediaId, sizeBytes: point.size_bytes };
  const appIds = Array.isArray(body.appIds) && body.appIds.every((appId: unknown) => typeof appId === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(appId))
    ? body.appIds as string[]
    : [];
  if (new Set(appIds).size !== appIds.length || appIds.some(appId => !(record.apps ?? []).includes(appId))) {
    return new Response('Restore selection contains an unavailable app', { status: 400 });
  }
  const restoreCore = body.restoreCore === true;
  if (!restoreCore && appIds.length === 0) return new Response('Select at least one app to restore', { status: 400 });

  const startedAt = new Date().toISOString();
  const restoreStatus: RestoreStatusRecord = {
    schema: 'youeye.backup.restore-status.v1',
    operationId,
    backupId: record.id,
    status: 'running',
    message: 'Validating encrypted backup',
    startedAt,
    updatedAt: startedAt,
  };
  await writeRestoreStatus(restoreStatus);

  let streamOpen = true;
  const stream = new ReadableStream({
    // Started inside the hold (a stream starts as it is made), so the locks taken below reuse its admission.
    async start(controller) {
      const encoder = new TextEncoder();
      const sendChunk = (chunk: string) => {
        if (!streamOpen) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Caddy is intentionally restarted during restore. Losing the optional
          // progress stream must never abort the durable restore operation.
          streamOpen = false;
        }
      };
      const send = (event: Record<string, unknown>) => sendChunk(`data: ${JSON.stringify(event)}\n\n`);
	  let rollbackPath = '';
	  let rollbackApps: string[] = [];
	  let preRestore: BackupSetRecord | null = null;
	  const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
	  // The watchdog stays out of the core services from here until the restore and its rollback have ended.
	  const releaseServices = restoreCore ? holdRestoreServices() : () => undefined;
	  // Each step goes to the Control Panel's log, the rollback's too: its events reach no client.
	  const logged = (phase: string) => (event: BackupEvent) =>
		console.log(`[restore] ${phase} ${operationId}: ${event.stage}: ${event.message}`);
      try {
		if (restoreCore) {
		  // The checks that can refuse the restore run first, so a refusal does not cost the pre-restore backup.
		  await withUserOperationLockWait(() => withRestoreLock(() =>
			fullRestore({ backupPath, passphrase, appIds, checkOnly: true }, () => undefined)));
		  send({ status: 'progress', stage: 'rollback-point', message: 'Protecting the current server state before restore', progress: 1 });
		  const rollback = await createPlatformBackup({ passphrase, reason: 'pre-restore' }, () => undefined);
		  rollbackPath = backupSetPath(rollback.id);
		  rollbackApps = rollback.apps ?? [];
		  preRestore = rollback;
		}
        await withUserOperationLockWait(() => withRestoreLock(async () => {
		  const relay = (event: BackupEvent) => {
			if (restoreCore) logged('restore')(event);
			send({
			  step: event.step,
			  totalSteps: event.totalSteps,
			  status: event.status,
			  stage: event.stage,
			  message: event.message,
			  progress: event.progress,
			});
		  };
          if (restoreCore) {
            await fullRestore({ backupPath, passphrase, appIds, progress }, relay);
            return;
          }
          await restoreApps({ backupPath, passphrase, appIds }, relay);
        }));
        const completedAt = new Date().toISOString();
        await writeRestoreStatus({
          ...restoreStatus,
          status: 'completed',
          message: restoreCore ? 'Restore completed. The server interface is restarting.' : 'Selected apps restored.',
          updatedAt: completedAt,
          completedAt,
        });
        if (restoreCore) await spineClient.restartControl(5);
		if (rollbackPath) await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
        send({ status: 'completed', stage: 'completed', message: restoreCore ? 'Restore completed. Server interface restart scheduled.' : 'Selected apps restored.', progress: 100 });
        sendChunk('data: [DONE]\n\n');
      } catch (error) {
		let message = error instanceof Error ? error.message : 'Restore failed';
		logOperationFailure(`Restore ${operationId}`, error);
		// The rollback is a restore of the pre-restore backup that, like the failed restore, keeps every app that was
		// not being restored; it is tried a second time if it fails. A restore refused before it changed anything is
		// not rolled back at all.
		if (restoreCore && rollbackPath && progress.changed) {
		  send({ status: 'progress', stage: 'rollback', message: 'Restore failed; returning the server to its previous state', progress: 98 });
		  try {
			await withUserOperationLockWait(() => withRestoreLock(() => rollBackRestore(
			  { passphrase, appIds, progress }, { backupPath: rollbackPath, apps: rollbackApps }, logged('rollback'))));
			await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
			message = `Restore failed and the previous server state was recovered: ${message}`;
		  } catch (rollbackError) {
			// The pre-restore backup holds the apps that were being replaced: it goes to the backup drive, where it
			// can be restored like any recovery point.
			const where = preRestore ? await preservePreRestoreBackup(preRestore, body.mediaId, passphrase)
			  : `kept on the server in ${rollbackPath}`;
			message = `Restore failed (${message}); automatic rollback also failed (${rollbackError instanceof Error ? rollbackError.message : rollbackError}). `
			  + `The apps that were not being restored are still installed; the state from before the restore is ${where}`;
		  }
		} else if (restoreCore && !progress.changed) {
		  if (rollbackPath) await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
		  message = `Restore refused, nothing on the server was changed: ${message}`;
		}
        const completedAt = new Date().toISOString();
        await writeRestoreStatus({
          ...restoreStatus,
          status: 'failed',
          message,
          error: message,
          updatedAt: completedAt,
          completedAt,
        }).catch(() => undefined);
        send({ status: 'error', stage: 'failed', message });
      } finally {
		releaseServices();
		hold.release();
        if (streamOpen) {
          try {
            controller.close();
          } catch {
            // The client already disconnected; durable status is authoritative.
          }
        }
        streamOpen = false;
      }
    },
    cancel() {
      streamOpen = false;
    },
  });
  streaming();
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
