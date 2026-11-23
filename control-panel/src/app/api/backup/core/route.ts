import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { createPlatformBackup } from '@/lib/backup/platform-backup';
import { listInstalledApps } from '@/lib/market/metadata';
import { readInstalledAppManifest } from '@/lib/market/frozen-manifest';
import { spineClient } from '@/lib/spine/client';
import { assessBackupCompatibility, readCurrentBackupSourceIdentity } from '@/lib/backup/compatibility';

export const dynamic = 'force-dynamic';

const NAME_WAIT_MS = 2_000;

async function installedAppName(appId: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), NAME_WAIT_MS); });
  try {
    const manifest = await Promise.race([readInstalledAppManifest(appId).catch(() => null), timeout]);
    return manifest?.metadata.name || null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const [apps, mediaResult, configResult, currentSource] = await Promise.all([
    listInstalledApps(),
    spineClient.getBackupMedia().catch(error => ({ media: [], error: error instanceof Error ? error.message : 'Drive detection unavailable' })),
    spineClient.getBackupConfig().catch(() => ({ enabled: false, targetPath: '', schedule: { core: { frequency: 'daily' as const, retention: 7, time: '03:00' }, defaultApp: { frequency: 'daily' as const, retention: 7 }, overrides: {} } })),
    readCurrentBackupSourceIdentity().catch(() => null),
  ]);
  const external = (await Promise.all(mediaResult.media
	.filter(item => item.state === 'available' || item.state === 'ready')
	.map(async item => {
	  const catalog = await spineClient.getExternalRecoveryPoints(item.id).catch(() => ({ recovery_points: [] }));
	  return catalog.recovery_points.map(point => ({
		id: point.backup_id,
		createdAt: point.created_at,
		completedAt: point.created_at,
		status: 'completed' as const,
		appCount: point.apps.length,
		apps: point.apps,
		mediaId: item.id,
		sizeBytes: point.size_bytes,
		reason: point.reason,
		verifiedAt: point.verified_at,
		source: point.source,
		compatibility: point.source && currentSource
		  ? assessBackupCompatibility(point.source, currentSource)
		  : { compatible: false, summary: 'This recovery point does not include compatibility evidence.' },
	  }));
	}))).flat();
  return NextResponse.json({
    backups: external.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // People choose apps by name: the installed copy's (local, right for any market), never a market read, since the
    // page asks every few seconds. An app whose copy can't be read in time keeps its id.
    apps: await Promise.all(apps.map(async app => ({ id: app.appId, name: (await installedAppName(app.appId)) || app.appId }))),
    media: mediaResult.media,
    mediaError: 'error' in mediaResult ? mediaResult.error : undefined,
    config: configResult,
  });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return new Response('Admin access required', { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.passphrase !== 'string' || typeof body.mediaId !== 'string' || !Array.isArray(body.appIds) || body.appIds.some((id: unknown) => typeof id !== 'string')) {
    return new Response('passphrase, backup drive, and app selection are required', { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let connected = true;
      const sendChunk = (chunk: string) => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { connected = false; }
      };
      const send = (event: Record<string, unknown>) => sendChunk(`data: ${JSON.stringify(event)}\n\n`);
      try {
        const record = await createPlatformBackup({
          passphrase: body.passphrase,
          mediaId: body.mediaId,
          selectedAppIds: body.appIds,
          reason: 'manual',
        }, event => send({
          step: event.step,
          totalSteps: event.totalSteps,
          status: event.status,
          stage: event.stage,
          message: event.message,
          progress: event.progress,
        }));
        send({ status: 'completed', stage: 'completed', message: 'Encrypted platform backup completed', progress: 100, backupId: record.id });
        sendChunk('data: [DONE]\n\n');
      } catch (error) {
        send({ status: 'error', stage: 'failed', message: error instanceof Error ? error.message : 'Backup failed' });
      } finally {
        if (connected) {
          try { controller.close(); } catch { /* Client disconnected; durable backup state is authoritative. */ }
        }
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
