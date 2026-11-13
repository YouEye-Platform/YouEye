/**
 * Setup Restore API
 *
 * POST /api/setup/restore — Execute a full platform restore from backup.
 * Streams progress via Server-Sent Events.
 *
 * New work requires incomplete setup. Exact-operation recovery remains available
 * through completion persistence, restart acknowledgement and a lost SSE reply.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { spineClient, SpineAPIError } from '@/lib/spine/client';
import { withSetupMutation } from '@/lib/setup/lifecycle';
import { fullRestore } from '@/lib/backup/full-restore';
import { validateBackupPassphrase, validateRestoreOperationId,
  readRestoreStatus, withRestoreLock } from '@/lib/backup/platform-backup';
import { assertSameSetupRestore, runSetupRestore, SetupRestoreError, SetupRestoreStore,
  setupRestoreTargetIdentity, type SetupRestoreIdentity } from '@/lib/setup/restore-recovery';
import { importFreshSetupRestoreSource } from '@/lib/setup/restore-source';

const restoreStore = new SetupRestoreStore();

interface RestoreRequest {
  mediaId?: string;
  backupId?: string;
  appIds?: string[];
  passphrase: string;
  operationId: string;
  action?: 'start' | 'resume';
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin || !session.setupOwnerId || !session.setupSessionId) {
    return NextResponse.json({ error: 'Claimed owner access required' }, { status: 403 });
  }
  if (request.nextUrl.searchParams.has('operationId')) {
    let operationId: string;
    try { operationId = validateRestoreOperationId(request.nextUrl.searchParams.get('operationId')); }
    catch { return NextResponse.json({ error: 'Invalid restore status request' }, { status: 400 }); }
    try {
      const retained = await restoreStore.readStatus(operationId);
      const record = retained?.record;
      if (record && record.identity.ownerId === session.setupOwnerId
        && record.identity.sessionId === session.setupSessionId
        && record.identity.target === setupRestoreTargetIdentity(await readFile('/var/lib/youeye/config/cli-token', 'utf8'))) {
        return NextResponse.json(retained.status, { headers: { 'Cache-Control': 'no-store' } });
      }
      return NextResponse.json({ error: 'Restore operation not found' }, { status: 404 });
    } catch {
      return NextResponse.json({ error: 'Restore status is temporarily unavailable', code: 'state-unavailable' }, { status: 503 });
    }
  }
  try {
    const media = await spineClient.getBackupMedia().catch(() => ({ media: [] }));
    const external = (await Promise.all(media.media
      .filter(item => item.state === 'available' || item.state === 'ready')
      .map(async item => {
        const catalog = await spineClient.getExternalRecoveryPoints(item.id).catch(() => ({ recovery_points: [] }));
        return catalog.recovery_points.map(point => ({
          backupId: point.backup_id,
          createdAt: point.created_at,
          apps: point.apps,
          mediaId: item.id,
          driveName: item.model || 'Backup drive',
        }));
      }))).flat();
    return NextResponse.json({ recoveryPoints: external.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  } catch {
    return NextResponse.json({ recoveryPoints: [] });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin || !session.setupOwnerId || !session.setupSessionId) {
    return new Response('Claimed owner access required', { status: 403 });
  }
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }
  let body: RestoreRequest;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid request body', { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body.action !== undefined && body.action !== 'start' && body.action !== 'resume')) {
    return new Response('Invalid restore action', { status: 400 });
  }

  try {
    body.passphrase = validateBackupPassphrase(body.passphrase);
    body.operationId = validateRestoreOperationId(body.operationId);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Invalid recovery key', { status: 400 });
  }
  if (!Array.isArray(body.appIds)
    || body.appIds.length > 1000
    || body.appIds.some(appId => typeof appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId))
    || new Set(body.appIds).size !== body.appIds.length) {
    return new Response('appIds must be an array', { status: 400 });
  }

  if (typeof body.mediaId !== 'string' || !body.mediaId || body.mediaId.length > 256
    || typeof body.backupId !== 'string' || !/^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(body.backupId)) {
    return new Response('An attached backup drive and recovery point are required', { status: 400 });
  }
  let identity: SetupRestoreIdentity;
  try {
    identity = { operationId: body.operationId, ownerId: session.setupOwnerId, sessionId: session.setupSessionId,
      mediaId: body.mediaId, backupId: body.backupId, appIds: body.appIds,
      target: setupRestoreTargetIdentity(await readFile('/var/lib/youeye/config/cli-token', 'utf8')) };
    const retained = await restoreStore.readStatus(body.operationId);
    if (retained) {
      assertSameSetupRestore(retained.record.identity, identity);
      if (retained.status.active) throw new SetupRestoreError('operation-active');
      if (body.action !== 'resume') throw new SetupRestoreError('resume-required');
      if (retained.status.recovery === 'operator-required') throw new SetupRestoreError('operator-required');
    } else {
      if (await readRestoreStatus(body.operationId, { strict: true })) throw new SetupRestoreError('operator-required');
      if (body.action === 'resume') throw new SetupRestoreError('operation-missing');
      if ((await spineClient.getConfig()).setup_completed === true) {
        return new Response('Setup already completed — restore is only available during initial setup', { status: 403 });
      }
    }
  } catch (error) {
    const code = error instanceof SetupRestoreError ? error.code : 'state-unavailable';
    return NextResponse.json({ error: 'The restore request needs reconciliation before continuing.', code },
      { status: code === 'state-unavailable' ? 503 : 409 });
  }
  let backupPath: string;
  async function importRecoveryPoint(expectedSource?: string): Promise<string> {
    const fresh = await importFreshSetupRestoreSource({
      backupId: body.backupId!, appIds: body.appIds!, expectedSource,
      importBackup: async () => {
        try {
          return (await spineClient.importBackupSet({
            media_id: body.mediaId!, backup_id: body.backupId!, passphrase: body.passphrase,
          })).backup_path;
        } catch (error) {
          // Only a native error response proves its invocation finished. A
          // transport failure leaves import intent for operator reconciliation.
          if (error instanceof SpineAPIError) throw new SetupRestoreError('import-failed');
          throw error;
        }
      },
    });
    backupPath = fresh.backupPath;
    return fresh.source;
  }

  const stream = new ReadableStream({
    async start(controller) {
      let connected = true;
      function send(data: Record<string, unknown>) {
        if (!connected) return;
        try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { connected = false; }
      }

      try {
        await withSetupMutation(session.setupOwnerId!, 'restore', body.operationId, async (settle) => {
          await withRestoreLock(async () => {
            await runSetupRestore(identity, body.action ?? 'start', {
              store: restoreStore, importSource: importRecoveryPoint, settle,
              setupCompleted: async () => (await spineClient.getConfig()).setup_completed === true,
              completeSetup: async () => { await spineClient.patchConfig({ setup_completed: true }); },
              restartControl: async () => { await spineClient.restartControl(5); },
              restore: async (checkpoint) => {
                await fullRestore({
                  backupPath, passphrase: body.passphrase, appIds: body.appIds,
                  setupMode: true, setupRecovery: checkpoint,
                }, (event) => {
                  // Driver errors and details can contain secrets.
                  send({
                    step: event.step, totalSteps: event.totalSteps, status: event.status,
                    stage: event.stage, progress: event.progress,
                    message: event.status === 'error' ? 'Restore step failed.' : 'Restoring your platform…',
                  });
                });
              },
            });
          });
        });

        send({ complete: true });
        if (connected) {
          try { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); } catch { connected = false; }
        }
      } catch (error) {
        send({ error: 'Restore did not complete. Read its status before continuing.',
          code: error instanceof SetupRestoreError ? error.code
            : error instanceof Error && error.message === 'App update executor lock is busy' ? 'operation-active' : 'restore-failed' });
      }

      if (connected) {
        try { controller.close(); } catch { /* Client disconnected; restore state is authoritative. */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
