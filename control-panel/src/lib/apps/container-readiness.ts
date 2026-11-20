import type { AppManifest, InstallMetadata } from '@/lib/market/types';

/** How to tell that a started container accepts work. */
export type ReadinessCheck =
  | { type: 'postgres'; user?: string; timeoutMs?: number }
  | { type: 'http'; port: number; path: string; timeoutMs?: number };

/** The app's own database engine: the container `database: { sidecar: … }` names. */
export function ownDatabaseEngine(metadata: InstallMetadata, manifest: AppManifest): string | undefined {
  if (manifest.database?.mode !== 'own') return undefined;
  return metadata.containers.find(c => c.name === manifest.database!.container && c.role === 'database')?.containerName;
}

/**
 * Readiness of one container, from the installed manifest: the app's own PostgreSQL (or any container with a
 * `postgres` health check) answers `pg_isready` as the app's user; any other container passes its declared HTTP
 * health check; null when it declares none (running is enough). Logs are never parsed. Used by updates (start and
 * reopen) and by the reconcile queue, so both bring an app up the same way.
 */
export function readinessCheck(metadata: InstallMetadata, manifest: AppManifest, containerName: string): ReadinessCheck | null {
  const spec = manifest.containers.find(c => c.name === metadata.containers.find(m => m.containerName === containerName)?.name);
  if (!spec) throw new Error('Container has no manifest declaration');
  const check = spec.healthCheck;
  if (check?.type === 'postgres' || ownDatabaseEngine(metadata, manifest) === containerName) {
    const user = check?.type === 'postgres' ? check.user
      : manifest.database?.user?.replaceAll('${app.id}', metadata.appId).replaceAll('${app.name}', metadata.appId);
    return { type: 'postgres', user, timeoutMs: check?.timeout };
  }
  if (check?.type === 'http') return { type: 'http', port: spec.port ?? 80, path: check.path, timeoutMs: check.timeout };
  return null;
}
