/**
 * Setup Restore API
 *
 * POST /api/setup/restore — Execute a full platform restore from backup.
 * Streams progress via Server-Sent Events.
 *
 * Only available when setup_completed is false (during initial setup).
 * Calls fullRestore() from the backup restore module and relays events.
 * On completion, marks setup as complete via spineClient.patchConfig.
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { spineClient } from '@/lib/spine/client';
import { fullRestore } from '@/lib/backup/full-restore';
import { recoveryImportErrorMessage, validateBackupPassphrase } from '@/lib/backup/platform-backup';

interface RestoreRequest {
  mediaId?: string;
  backupId?: string;
  appIds?: string[];
  passphrase: string;
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin || !session.setupOwnerId) {
    return NextResponse.json({ error: 'Claimed owner access required' }, { status: 403 });
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
  if (!session?.isAdmin || !session.setupOwnerId) {
    return new Response('Claimed owner access required', { status: 403 });
  }
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }
  // Guard: only available during initial setup
  try {
    const config = await spineClient.getConfig();
    if (config.setup_completed === true) {
      return new Response('Setup already completed — restore is only available during initial setup', { status: 403 });
    }
  } catch {
    // Spine not reachable — allow restore to proceed (setup not complete)
  }

  let body: RestoreRequest;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid request body', { status: 400 });
  }

  try {
    body.passphrase = validateBackupPassphrase(body.passphrase);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Invalid recovery key', { status: 400 });
  }
  if (!Array.isArray(body.appIds)
    || body.appIds.some(appId => typeof appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId))
    || new Set(body.appIds).size !== body.appIds.length) {
    return new Response('appIds must be an array', { status: 400 });
  }

  if (typeof body.mediaId !== 'string' || typeof body.backupId !== 'string') {
    return new Response('An attached backup drive and recovery point are required', { status: 400 });
  }
  let backupPath: string;
  try {
      const imported = await spineClient.importBackupSet({
        media_id: body.mediaId,
        backup_id: body.backupId,
        passphrase: body.passphrase,
      });
      backupPath = await realpath(imported.backup_path);
  } catch (error) {
    return new Response(recoveryImportErrorMessage(error), { status: 400 });
  }
  try {
	const allowedRoots = await Promise.all(['/var/lib/youeye/backups'].map(async root => {
      try { return await realpath(root); } catch { return path.resolve(root); }
    }));
    if (!allowedRoots.some(root => backupPath === root || backupPath.startsWith(`${root}${path.sep}`))) {
	  return new Response('Backup path must be under the protected YouEye backup root', { status: 400 });
    }
    if (!(await stat(backupPath)).isDirectory()) {
      return new Response('Backup path must be a directory', { status: 400 });
    }
  } catch {
    return new Response('Backup path does not exist or cannot be read', { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let connected = true;
      function send(data: Record<string, unknown>) {
        if (!connected) return;
        try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { connected = false; }
      }

      try {
        await fullRestore(
          {
            backupPath,
            passphrase: body.passphrase,
            appIds: body.appIds,
            setupMode: true,
          },
          (event) => {
            send({
              step: event.step,
              totalSteps: event.totalSteps,
              status: event.status,
              stage: event.stage,
              message: event.message,
              detail: event.detail,
              progress: event.progress,
            });
          }
        );

        // Mark setup as complete — the restored config includes setup_completed
        // but we explicitly set it to ensure the wizard redirects to dashboard
        await spineClient.patchConfig({ setup_completed: true });

        send({ complete: true });
        if (connected) {
          try { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); } catch { connected = false; }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('[restore] Full restore failed:', err);
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
