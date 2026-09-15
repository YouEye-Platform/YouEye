import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return new Response('Admin access required', { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.action !== 'string') return new Response('action is required', { status: 400 });

  try {
    if (body.action === 'prepare' && typeof body.mediaId === 'string' && body.confirm === true) {
      return NextResponse.json(await spineClient.prepareBackupMedia(body.mediaId));
    }
	if (body.action === 'eject' && typeof body.mediaId === 'string') {
	  return NextResponse.json(await spineClient.ejectBackupMedia(body.mediaId));
	}
    if (body.action === 'import' && typeof body.mediaId === 'string' && typeof body.backupId === 'string' && typeof body.passphrase === 'string') {
      return NextResponse.json(await spineClient.importBackupSet({
        media_id: body.mediaId,
        backup_id: body.backupId,
        passphrase: body.passphrase,
      }));
    }
    if (body.action === 'schedule' && body.enabled === false) {
	  const current = await spineClient.getBackupConfig().catch(() => null);
	  if (current) await spineClient.setBackupConfig({ ...current, enabled: false });
	  return NextResponse.json({ status: 'saved' });
	}
    if (body.action === 'schedule' && typeof body.mediaId === 'string' && typeof body.passphrase === 'string' && Array.isArray(body.appIds) && body.appIds.every((id: unknown) => typeof id === 'string')) {
      if (body.passphrase.length < 12 || body.passphrase.length > 256) return new Response('Recovery key must contain 12 to 256 characters', { status: 400 });
	  const appFrequencies = body.appFrequencies && typeof body.appFrequencies === 'object' ? body.appFrequencies as Record<string, unknown> : {};
	  if (body.appIds.some((id: string) => appFrequencies[id] !== 'daily' && appFrequencies[id] !== 'weekly')) return new Response('Each selected app needs a backup frequency', { status: 400 });
	  const existing = await spineClient.getBackupConfig().catch(() => null);
      await spineClient.storeBackupRecoveryKey(body.passphrase);
      const frequency = body.frequency === 'weekly' ? 'weekly' : 'daily';
      const time = typeof body.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : '03:00';
      await spineClient.setBackupConfig({
        enabled: true,
        targetPath: '',
        mediaId: body.mediaId,
        selectedApps: body.appIds,
        recoveryKeyStored: true,
        schedule: {
		  core: { ...existing?.schedule?.core, frequency, retention: 7, time },
          defaultApp: { frequency, retention: 7 },
		overrides: Object.fromEntries(body.appIds.map((id: string) => [id, { ...existing?.schedule?.overrides?.[id], frequency: appFrequencies[id] as 'daily' | 'weekly', retention: 7 }])),
        },
      });
      return NextResponse.json({ status: 'saved' });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Backup drive action failed' }, { status: 400 });
  }
  return new Response('Invalid backup drive action', { status: 400 });
}
