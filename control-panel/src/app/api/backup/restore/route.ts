import { NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { fullRestore } from '@/lib/backup/full-restore';
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
} from '@/lib/backup/platform-backup';
import { spineClient } from '@/lib/spine/client';
import { restoreApp } from '@/lib/backup/app-restore';
import type { BackupEvent } from '@/lib/backup/types';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';

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
      try {
		if (restoreCore) {
		  send({ status: 'progress', stage: 'rollback-point', message: 'Protecting the current server state before restore', progress: 1 });
		  const rollback = await createPlatformBackup({ passphrase, reason: 'pre-restore' }, () => undefined);
		  rollbackPath = backupSetPath(rollback.id);
		}
        await withRestoreLock(async () => {
		  const relay = (event: BackupEvent) => send({
            step: event.step,
            totalSteps: event.totalSteps,
            status: event.status,
            stage: event.stage,
            message: event.message,
            progress: event.progress,
          });
          if (restoreCore) {
            await fullRestore({ backupPath, passphrase, appIds }, relay);
            return;
          }
          for (const appId of appIds) {
            const appDirectory = path.join(backupPath, 'youeye', 'apps', appId);
            const archives = (await readdir(appDirectory)).filter(file => file.endsWith('.tar.enc')).sort().reverse();
            if (!archives[0]) throw new Error(`No archive found for ${appId}`);
            await restoreApp({ appId, archivePath: path.join(appDirectory, archives[0]), passphrase }, relay);
          }
        });
        const completedAt = new Date().toISOString();
        await writeRestoreStatus({
          ...restoreStatus,
          status: 'completed',
          message: restoreCore ? 'Restore completed. The server interface is restarting.' : 'Selected apps restored.',
          updatedAt: completedAt,
          completedAt,
        });
		if (rollbackPath) await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
        send({ status: 'completed', stage: 'completed', message: restoreCore ? 'Restore completed. Server interface restart scheduled.' : 'Selected apps restored.', progress: 100 });
        sendChunk('data: [DONE]\n\n');
        if (restoreCore) await spineClient.restartControl(5).catch(() => undefined);
      } catch (error) {
		let message = error instanceof Error ? error.message : 'Restore failed';
		if (restoreCore && rollbackPath) {
		  send({ status: 'progress', stage: 'rollback', message: 'Restore failed; returning the server to its previous state', progress: 98 });
		  try {
			await withRestoreLock(() => fullRestore({ backupPath: rollbackPath, passphrase }, () => undefined));
			await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
			message = `Restore failed and the previous server state was recovered: ${message}`;
		  } catch (rollbackError) {
			message = `Restore failed (${message}); automatic rollback also failed (${rollbackError})`;
		  }
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
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
