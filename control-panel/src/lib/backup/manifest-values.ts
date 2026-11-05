import type { ManifestBackupSection } from './types';
import type { AppManifest } from '@/lib/market/types';

export function resolveAppManifestValue(value: string, appId: string): string {
  return value
    .replaceAll('${app.id}', appId)
    .replaceAll('${app.name}', appId);
}

export function resolveOwnPostgres(
  value: NonNullable<ManifestBackupSection['ownPostgres']>,
  appId: string,
) {
  const database = resolveAppManifestValue(value.database, appId);
  return {
    container: resolveAppManifestValue(value.container, appId),
    database,
    user: resolveAppManifestValue(value.user || database, appId),
  };
}

export function resolveSharedDatabasePasswordFile(
  manifest: Pick<AppManifest, 'secrets'>,
): string {
  const passwordFile = manifest.secrets.find(secret => secret.name === 'db_password')?.file
    ?? 'db-password';
  if (!/^[A-Za-z0-9._-]+$/.test(passwordFile) || passwordFile === '.' || passwordFile === '..') {
    throw new Error('Shared database password file is outside the app-owned secret directory');
  }
  return passwordFile;
}
