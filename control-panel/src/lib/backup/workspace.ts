import { createHash } from 'node:crypto';
import path from 'node:path';
import { getInstanceState } from '@/lib/incus/server';

export const BACKUP_ROOT = '/var/lib/youeye/backups';
export const BACKUP_STAGING_ROOT = path.join(BACKUP_ROOT, '.staging');

export interface BackupVolumeMapping {
  source: string;
  archive_path: string;
}

export function volumeMappings(sources: string[]): BackupVolumeMapping[] {
  return [...new Set(sources.map(source => path.resolve(source)))]
    .filter(source => source.startsWith('/var/lib/youeye/') && !source.startsWith(`${BACKUP_ROOT}/`))
    .sort()
    .map(source => {
      const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
      const name = path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_') || 'data';
      return { source, archive_path: `volumes/${digest}-${name}` };
    });
}

export async function runningContainers(candidates: string[]): Promise<string[]> {
  const running: string[] = [];
  for (const name of [...new Set(candidates.filter(Boolean))].sort()) {
    try {
      const state = await getInstanceState(name);
      const status = (state.metadata as { status?: string } | undefined)?.status;
      if (status === 'Running') running.push(name);
    } catch {
      // A removed or optional container is not a backup failure.
    }
  }
  return running;
}
