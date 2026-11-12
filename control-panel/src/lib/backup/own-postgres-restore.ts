import type { AppManifest } from '@/lib/market/types';
import { getContainerName } from '@/lib/market/engine-helpers';
import { resolveAppManifestValue, resolveOwnPostgres } from './manifest-values';

/** Frozen manifest binds the app's logical owner to its restored secret. */
export function resolveOwnPostgresRestore(manifest: AppManifest, appId: string) {
  const declaration = manifest.backup?.ownPostgres;
  if (manifest.database?.mode !== 'own' || !declaration) {
    throw new Error('Backup is missing own-database restore metadata');
  }
  const own = resolveOwnPostgres(declaration, appId);
  const databaseContainer = manifest.containers.find(spec =>
    getContainerName(appId, spec.name, manifest.containers.length) === own.container);
  if (!databaseContainer || databaseContainer.name !== manifest.database.container
    || own.container.startsWith('youeye-')
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(own.container)) {
    throw new Error('Application database restore target is outside its declared runtime');
  }
  // The app's env (env_mapping) belongs to its main container, as at install.
  const envOf = (spec: AppManifest['containers'][number]) => ({ ...(spec.primary ? manifest.env_mapping : {}), ...spec.environment });
  const databaseEnv = envOf(databaseContainer);
  const adminUser = resolveAppManifestValue(databaseEnv.POSTGRES_USER || 'postgres', appId);
  if ([own.database, own.user, adminUser].some(value => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))
    || ['postgres', 'template0', 'template1', 'youeye', 'youeye_ui', 'pointer'].includes(own.database)) {
    throw new Error('Application database restore identity is unavailable');
  }
  if (own.user === adminUser) return { ...own, adminUser, passwordFile: undefined };
  const passwordSources = manifest.containers.flatMap(spec => {
    const env = envOf(spec);
    if (resolveAppManifestValue(env.PGUSER || '', appId) !== own.user) return [];
    const match = /^\$\{secret\.([a-z0-9_]+)\}$/.exec(env.PGPASSWORD || '');
    const secret = match && manifest.secrets.find(item => item.name === match[1]);
    if (!secret || secret.file !== `secrets/${secret.name}`) return [];
    return [secret.name];
  });
  const files = [...new Set(passwordSources)];
  if (files.length !== 1) throw new Error('Application database owner needs one declared restored password secret');
  // `passwordFile` is the secret's name in the app's secret store.
  return { ...own, adminUser, passwordFile: files[0] };
}
