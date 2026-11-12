/**
 * Variables for setup files of an already installed app (re-runs after a URL change, the
 * sign-in toggle): the same canonical context the install used, rebuilt from the install
 * metadata, the app's secrets on disk and its existing OAuth client (never rotated here).
 */

import { readAppSecret } from '@/lib/infrastructure/secrets';
import { getClient } from '@/lib/identity/store';
import { buildCanonicalContext, clearPlatformContextCache } from './platform-env';
import type { AppManifest, InstallMetadata, VariableContext } from './types';

export type SsoClient = { clientId: string; clientSecret: string; slug: string };

/** The app's secrets by name (missing files are left out; a step using one then fails). */
export async function readInstalledSecrets(manifest: Pick<AppManifest, 'secrets'>, appId: string): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const secret of manifest.secrets) {
    const value = await readAppSecret(appId, secret.name);
    if (value) secrets[secret.name] = value;
  }
  return secrets;
}

/** The installed app's OAuth client, when YouEye ID sign-in is on. */
export async function installedSsoClient(meta: InstallMetadata): Promise<SsoClient | undefined> {
  const clientId = meta.ssoClientId || meta.ssoSlug;
  if (!meta.enableSSO || !clientId) return undefined;
  const client = await getClient(clientId);
  if (!client) return undefined;
  return { clientId, clientSecret: client.client_secret || '', slug: meta.ssoSlug || `youeye-app-${meta.appId}` };
}

/**
 * Runtime container name per logical container, as the install record holds them (never
 * derived from the app id). A container the manifest names but the record lacks is an error.
 */
export function setupContainers(manifest: Pick<AppManifest, 'containers'>, meta: Pick<InstallMetadata, 'appId' | 'containers'>): Record<string, string> {
  const recorded = new Map((meta.containers ?? []).map((container) => [container.name, container.containerName]));
  return Object.fromEntries(manifest.containers.map((spec) => {
    const name = recorded.get(spec.name);
    if (!name) throw new Error(`The install record of ${meta.appId} has no container "${spec.name}"`);
    return [spec.name, name];
  }));
}

export async function installedSetupVariables(
  manifest: AppManifest,
  meta: InstallMetadata,
  options: { domain?: string; sso?: SsoClient | null } = {},
): Promise<Partial<VariableContext>> {
  clearPlatformContextCache();
  const secrets = await readInstalledSecrets(manifest, meta.appId);
  const sso = options.sso === null ? undefined : options.sso ?? await installedSsoClient(meta);
  const ctx = await buildCanonicalContext(
    manifest,
    { appId: meta.appId, subdomain: meta.subdomain, domain: options.domain ?? meta.domain },
    sso,
    secrets.db_password,
    undefined,
    true,
  );
  if (options.domain && ctx.platform && ctx.app) {
    ctx.platform.domain = options.domain;
    ctx.app.fqdn = `${meta.subdomain}.${options.domain}`;
    ctx.app.url = `https://${ctx.app.fqdn}`;
  }
  ctx.secret = secrets;
  return ctx;
}
