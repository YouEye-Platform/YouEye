import { createPlatformBackup } from './platform-backup';
import { spineClient } from '@/lib/spine/client';
import type { BackupScheduleConfig } from './types';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';

const CHECK_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastFailureAt = 0;
let attachedMedia = new Set<string>();

export async function checkBackupMediaOffers(): Promise<void> {
  const inventory = await spineClient.getBackupMedia().catch(() => ({ media: [] }));
  const current = new Set(inventory.media.filter(media => media.state !== 'unsupported').map(media => media.id));
  for (const media of inventory.media) {
    if (media.state === 'unsupported' || attachedMedia.has(media.id)) continue;
    await sendNotificationToUI({
      title: media.state === 'blank' ? 'Backup drive detected' : 'Backup drive ready',
      message: media.state === 'blank' ? 'Prepare this drive in Settings to create encrypted YouEye backups.' : 'Create a recovery point now or use this drive for automatic backups.',
      type: 'info',
      source: 'system',
      userId: null,
      actionUrl: '/settings/backup',
    }).catch(() => undefined);
  }
  // Removing an ID means a later insertion is a new event and is offered again.
  attachedMedia = current;
}

function entryDue(entry: { frequency: string; last_run?: string }, now: Date, time: string): boolean {
  if (entry.frequency !== 'daily' && entry.frequency !== 'weekly') return false;
  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const boundary = new Date(now);
  boundary.setHours(hour, minute, 0, 0);
  if (now < boundary) return false;
  const lastRun = Date.parse(entry.last_run || '');
  const interval = entry.frequency === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return !Number.isFinite(lastRun) || lastRun < boundary.getTime() - (entry.frequency === 'weekly' ? interval - 24 * 60 * 60 * 1000 : 0);
}

function dueApps(config: BackupScheduleConfig, now: Date): string[] {
  const time = config.schedule.core.time || '03:00';
  return (config.selectedApps ?? []).filter(appId => entryDue(config.schedule.overrides[appId] || config.schedule.defaultApp, now, time));
}

async function saveResult(config: BackupScheduleConfig, completedAt?: string, completedApps: string[] = [], error?: string) {
  const core = { ...config.schedule.core };
  if (completedAt) core.last_run = completedAt;
  const overrides = { ...config.schedule.overrides };
  if (completedAt) {
    for (const appId of completedApps) overrides[appId] = { ...overrides[appId], last_run: completedAt };
  }
  await spineClient.setBackupConfig({
    ...config,
    lastError: error?.slice(0, 500) || undefined,
	  schedule: { ...config.schedule, core, overrides },
  });
}

export async function checkScheduledBackup(now = new Date()): Promise<void> {
  if (running || Date.now() - lastFailureAt < 30 * 60 * 1000) return;
  const config = await spineClient.getBackupConfig().catch(() => null);
	if (!config || !config.enabled || !config.mediaId || !config.recoveryKeyStored) return;
	const selectedAppIds = dueApps(config, now);
	const coreDue = entryDue(config.schedule.core, now, config.schedule.core.time || '03:00');
	if (!coreDue && selectedAppIds.length === 0) return;

  running = true;
  try {
    const inventory = await spineClient.getBackupMedia();
    const media = inventory.media.find(item => item.id === config.mediaId && (item.state === 'available' || item.state === 'ready'));
    if (!media) {
      // Missing removable media is expected. Keep the point due so inserting
      // the configured drive starts it on the next check without user action.
	  await saveResult(config, undefined, [], 'Waiting for the configured backup drive.');
      return;
    }
    await createPlatformBackup({
      useStoredPassphrase: true,
	  selectedAppIds,
      mediaId: config.mediaId,
      reason: 'scheduled',
    }, () => undefined);
	await saveResult(config, now.toISOString(), selectedAppIds);
    lastFailureAt = 0;
  } catch (error) {
    lastFailureAt = Date.now();
	await saveResult(config, undefined, [], error instanceof Error ? error.message : 'Automatic backup failed').catch(() => undefined);
  } finally {
    running = false;
  }
}

export function startBackupScheduler(): void {
  if (timer) return;
  setTimeout(() => { void checkBackupMediaOffers(); void checkScheduledBackup(); }, 30_000);
  timer = setInterval(() => { void checkBackupMediaOffers(); void checkScheduledBackup(); }, CHECK_INTERVAL_MS);
}
