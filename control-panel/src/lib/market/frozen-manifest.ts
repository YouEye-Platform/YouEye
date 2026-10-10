import { execCommand } from '@/lib/incus/server';
import { AppManifestSchema } from './schema';
import { AppUpdatePreflightError } from './update-inventory';
import type { AppManifest } from './types';

/** Installed registration is the runtime contract; a mutable catalog is not. */
export function parseFrozenAppManifest(raw: string, appId: string, installedVersion?: string): AppManifest {
  try {
    const manifest = AppManifestSchema.parse(JSON.parse(raw));
    if (manifest.metadata.id !== appId) throw new Error('Wrong app');
    if (installedVersion && manifest.version !== installedVersion) {
      throw new AppUpdatePreflightError('frozen-version-mismatch',
        'Installed manifest and recorded runtime version disagree.');
    }
    return manifest;
  } catch (error) {
    if (error instanceof AppUpdatePreflightError) throw error;
    throw new AppUpdatePreflightError('frozen-manifest-unavailable',
      'A complete frozen installed manifest is required.');
  }
}

export async function readFrozenUpdateManifest(appId: string, installedVersion?: string): Promise<AppManifest> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Invalid app identity');
  const result = await execCommand('youeye-postgres', [
    'psql', '-U', 'youeye', '-d', 'youeye_ui', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT manifest::text FROM apps WHERE id='${appId}'`,
  ], { timeout: 10_000 });
  if (result.exitCode !== 0) {
    throw new AppUpdatePreflightError('frozen-manifest-unavailable',
      'The installed app manifest could not be read.');
  }
  return parseFrozenAppManifest(result.stdout, appId, installedVersion);
}
