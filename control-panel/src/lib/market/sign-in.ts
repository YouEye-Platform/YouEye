/**
 * The "YouEye ID sign-in" setting of an installed app whose SSO needs a setup file
 * (`setup/sso.yaml`). Turning it on creates the app's OAuth client and runs the file's `steps:`;
 * turning it off runs its `remove:` steps and then removes the client. The install-time toggle
 * is the same setting (`selectedIntegrations: ['youeye-id']`).
 */

import { ensureAppAdmission } from '@/lib/admission/store';
import { createOAuthClient, removeOAuthClient } from '@/lib/identity/provider';
import { addSystemProxyDevices, applyAppEgressAcl, getSystemServices } from '@/lib/incus/app-network';
import { injectCaddyRootCA } from './caddy-ca';
import { pushSsoEntryUrlToUI } from './engine';
import { readFrozenUpdateManifest } from './frozen-manifest';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import { installedSetupVariables, installedSsoClient, setupContainers, type SsoClient } from './setup-context';
import { runSetup, setupFor } from './setup-runner';
import type { AppManifest, InstallMetadata } from './types';
import { withAppLifecycle } from './update-admission';
import { resolveVariables } from './variables';

export const IDENTITY_SIGN_IN = 'youeye-id';

export interface SignInResult {
  appId: string;
  enabled: boolean;
  /** Whether setup steps ran (`steps:` when enabling, `remove:` when disabling). */
  ran: boolean;
}

function oauthScopes(manifest: AppManifest): string[] {
  const scopes = new Set(['openid', 'profile', 'email', 'groups']);
  if (manifest.sso?.role_claim) scopes.add(manifest.sso.role_claim.claim);
  return [...scopes];
}

async function createClient(manifest: AppManifest, meta: InstallMetadata): Promise<SsoClient> {
  const sso = manifest.sso!;
  const slug = `youeye-app-${meta.appId}`;
  const appUrl = `https://${meta.subdomain}.${meta.domain}`;
  const ctx = await installedSetupVariables(manifest, meta, { sso: null });
  const redirectUris = [sso.callback_path, ...sso.additional_callbacks].map((callback) =>
    callback.startsWith('/') ? `${appUrl}${resolveVariables(callback, ctx)}` : callback);
  const result = await createOAuthClient({
    clientId: slug,
    name: manifest.metadata.name,
    redirectUris,
    postLogoutRedirectUris: [`https://${meta.domain}/`, `${appUrl}/`],
    backchannelLogoutUri: sso.backchannel_logout_path ? `${appUrl}${sso.backchannel_logout_path}` : undefined,
    scopes: oauthScopes(manifest),
    roleClaim: sso.role_claim ?? null,
  });
  return { clientId: result.clientId, clientSecret: result.clientSecret, slug };
}

/** Let the app's containers reach YouEye ID (gateway proxy, egress policy, Caddy root CA). */
async function openIdentityPath(manifest: AppManifest, meta: InstallMetadata): Promise<void> {
  const needsSharedDb = manifest.database?.mode === 'shared';
  const needsAI = Boolean(meta.aiConnection);
  await addSystemProxyDevices(meta.appId, await getSystemServices({ needsSharedDb, needsSSO: true, needsAI }));
  const containers = setupContainers(manifest, meta);
  await applyAppEgressAcl(meta.appId, Object.values(containers), { needsSharedDb, needsSSO: true, needsAI });
  for (const spec of manifest.containers) {
    if (spec.type === 'oci') await injectCaddyRootCA(containers[spec.name]);
  }
}

async function enable(manifest: AppManifest, meta: InstallMetadata): Promise<SignInResult> {
  let client = await installedSsoClient(meta);
  const created = !client;
  if (!client) {
    await openIdentityPath(manifest, meta);
    client = await createClient(manifest, meta);
    // Turning sign-in off deleted the old client and, with it, its admission binding; without a binding
    // YouEye ID refuses every sign-in to the app ("The user denied this app request").
    try {
      await ensureAppAdmission({ appId: meta.appId, clientId: client.clientId, installed: true,
        routes: [{ host: `${meta.subdomain}.${meta.domain}`.toLowerCase() }] });
    } catch (error) {
      await removeOAuthClient(client.clientId).catch(() => undefined);
      throw error;
    }
  }
  const variables = await installedSetupVariables(manifest, { ...meta, enableSSO: true }, { sso: client });
  let ran: boolean;
  try {
    ran = await runSetup(manifest, 'sso', { appId: meta.appId, containers: setupContainers(manifest, meta), variables });
  } catch (error) {
    if (created) await removeOAuthClient(client.clientId).catch(() => undefined);
    throw error;
  }
  meta.enableSSO = true;
  meta.hasSSO = true;
  meta.ssoSlug = client.slug;
  meta.ssoClientId = client.clientId;
  meta.selectedIntegrations = [...new Set([...(meta.selectedIntegrations ?? []), IDENTITY_SIGN_IN])];
  if (manifest.sso?.entry_url) {
    meta.ssoEntryUrl = resolveVariables(manifest.sso.entry_url, variables);
    await pushSsoEntryUrlToUI(meta.appId, meta.ssoEntryUrl).catch((error) =>
      console.warn(`[sign-in] ${meta.appId}: SSO entry URL not pushed:`, error));
  }
  await saveInstallMetadata(meta);
  return { appId: meta.appId, enabled: true, ran };
}

async function disable(manifest: AppManifest, meta: InstallMetadata): Promise<SignInResult> {
  if (!meta.enableSSO) return { appId: meta.appId, enabled: false, ran: false };
  const client = await installedSsoClient(meta);
  const variables = await installedSetupVariables(manifest, meta, { sso: client ?? null });
  // A failing remove step leaves sign-in on (the app is still configured for it).
  const ran = await runSetup(manifest, 'sso', {
    appId: meta.appId, containers: setupContainers(manifest, meta), variables, remove: true,
  });
  if (client) await removeOAuthClient(client.clientId);
  meta.enableSSO = false;
  meta.hasSSO = false;
  delete meta.ssoSlug;
  delete meta.ssoClientId;
  delete meta.ssoEntryUrl;
  meta.selectedIntegrations = (meta.selectedIntegrations ?? []).filter((id) => id !== IDENTITY_SIGN_IN);
  await saveInstallMetadata(meta);
  await pushSsoEntryUrlToUI(meta.appId, null).catch((error) =>
    console.warn(`[sign-in] ${meta.appId}: SSO entry URL not cleared:`, error));
  return { appId: meta.appId, enabled: false, ran };
}

/** A refusal whose message is safe to show (unlike setup failures, which are logged instead). */
export class SignInRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInRefusal';
  }
}

export interface SignInStatus {
  appId: string;
  /** The app has `sso:` and a `setup/sso.yaml`, so sign-in can change after install. */
  available: boolean;
  enabled: boolean;
}

/** Whether an installed app has the sign-in setting, and its current state. */
export async function getAppSignIn(appId: string): Promise<SignInStatus> {
  const meta = await readInstallMetadata(appId);
  if (!meta || meta.lifecycleState === 'installing') throw new SignInRefusal(`App "${appId}" is not installed`);
  const manifest = await readFrozenUpdateManifest(appId);
  return { appId, available: Boolean(manifest.sso && setupFor(manifest, 'sso')), enabled: Boolean(meta.enableSSO) };
}

/** Turn YouEye ID sign-in on or off for an installed app (from its frozen manifest). */
export async function setAppSignIn(appId: string, enabled: boolean): Promise<SignInResult> {
  return withAppLifecycle(appId, async () => {
    const meta = await readInstallMetadata(appId);
    if (!meta || meta.lifecycleState === 'installing') throw new SignInRefusal(`App "${appId}" is not installed`);
    const manifest = await readFrozenUpdateManifest(appId);
    if (!manifest.sso || !setupFor(manifest, 'sso')) {
      throw new SignInRefusal(`${manifest.metadata.name} has no YouEye ID sign-in setting`);
    }
    return enabled ? enable(manifest, meta) : disable(manifest, meta);
  });
}
