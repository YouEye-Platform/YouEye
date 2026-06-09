import { readSecret } from '@/lib/infrastructure/secrets';
import { getContainerIP } from '@/lib/incus/container-ip';
import { execShell } from '@/lib/incus/server';
import { createOAuthClient, getIdentityProviderConfig } from '@/lib/identity/provider';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import { fetchIntegrationManifestReferenceFromSource, fetchIntegrationManifestFromSource, fetchManifestFromSource } from './catalog';
import { buildCanonicalContext, generateAppToken } from './platform-env';
import { executeSSOSteps, StepError } from './sso-engine';
import { getContainerName } from './engine-helpers';
import { injectCaddyRootCA } from './caddy-ca';
import { resolveVariables } from './variables';
import type { AppManifest, InstallConfig, InstallEvent, IntegrationManifest, VariableContext } from './types';

export interface ApplyIntegrationInput {
  integrationId: string;
  sourceId?: string;
}

export interface ApplyIntegrationResult {
  integrationId: string;
  targetAppId: string;
  sourceId?: string;
  manifestDigest?: string;
}

function emit(
  onEvent: (event: InstallEvent) => void,
  step: number,
  totalSteps: number,
  status: InstallEvent['status'],
  message: string,
  detail?: string
) {
  onEvent({ step, totalSteps, status, message, detail, phase: 'install' });
}

function makeConfig(appManifest: AppManifest, targetMeta: NonNullable<Awaited<ReturnType<typeof readInstallMetadata>>>): InstallConfig {
  return {
    appId: targetMeta.appId,
    catalogKey: targetMeta.catalogKey,
    sourceId: targetMeta.sourceId,
    sourceName: targetMeta.sourceName,
    sourceRepoUrl: targetMeta.sourceRepoUrl,
    subdomain: targetMeta.subdomain,
    domain: targetMeta.domain,
    selectedIntegrations: targetMeta.selectedIntegrations,
    allowInternet: true,
  };
}

async function readAppSecrets(appManifest: AppManifest, appId: string): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const secret of appManifest.secrets) {
    const value = await readSecret(`app-${appId}`, secret.file);
    if (!value) {
      throw new Error(`Missing required secret for ${appId}: ${secret.file}`);
    }
    secrets[secret.name] = value;
  }
  return secrets;
}

function integrationContextManifest(appManifest: AppManifest, integration: IntegrationManifest): AppManifest {
  return {
    ...appManifest,
    sso: integration.sso ?? appManifest.sso,
  };
}

function oauthScopesForSSO(sso: IntegrationManifest['sso']): string[] {
  const scopes = new Set(['openid', 'profile', 'email', 'groups']);
  if (sso?.adminMapping?.type === 'roleClaim') {
    scopes.add(sso.adminMapping.claimName);
  }
  return [...scopes];
}

async function ensureIntegrationOAuthClient(
  contextManifest: AppManifest,
  integration: IntegrationManifest,
  config: InstallConfig,
  ctx: Partial<VariableContext>
): Promise<{ clientId: string; clientSecret: string; slug: string } | undefined> {
  const sso = integration.sso ?? contextManifest.sso;
  if (!sso) return undefined;

  const identity = await getIdentityProviderConfig();
  const slug = `youeye-app-${config.appId}`;
  const appUrl = `https://${config.subdomain}.${config.domain}`;
  const redirectUris: string[] = [];

  if (sso.callback_path) {
    redirectUris.push(`${appUrl}${resolveVariables(sso.callback_path, ctx)}`);
  }
  for (const cb of sso.additional_callbacks || []) {
    redirectUris.push(resolveVariables(cb, ctx));
  }

  const result = await createOAuthClient({
    clientId: slug,
    name: `${contextManifest.metadata.name} ${integration.metadata.name}`,
    redirectUris,
    scopes: oauthScopesForSSO(sso),
  });

  return { clientId: result.clientId, clientSecret: result.clientSecret, slug };
}

async function executeIntegrationSetup(
  contextManifest: AppManifest,
  integration: IntegrationManifest,
  ctx: Partial<VariableContext>,
  targetMeta: NonNullable<Awaited<ReturnType<typeof readInstallMetadata>>>
): Promise<void> {
  const sso = integration.sso;
  if (!sso?.setup || sso.setup.method === 'none' || sso.setup.method === 'env') return;

  const primaryMeta = targetMeta.containers.find((container) => container.port) ?? targetMeta.containers[0];
  if (!primaryMeta) throw new Error(`Installed app ${targetMeta.appId} has no containers`);

  const primaryContainerName = primaryMeta.containerName || getContainerName(targetMeta.appId, primaryMeta.name, targetMeta.containers.length);
  const primaryPort = primaryMeta.port || contextManifest.containers.find((container) => container.primary)?.port || contextManifest.containers[0]?.port || 3000;
  const primaryIP = await getContainerIP(primaryContainerName);
  if (!primaryIP) throw new Error(`Could not resolve IP for ${primaryContainerName}`);
  ctx.container = { ip: primaryIP, port: primaryPort };

  if (sso.type === 'oauth2') {
    await injectCaddyRootCA(primaryContainerName);
  }

  if (sso.setup.method === 'cli') {
    for (const cliStep of sso.setup.cli?.steps ?? []) {
      const command = resolveVariables(cliStep.exec, ctx);
      await execShell(primaryContainerName, command, { timeout: cliStep.timeout });
    }
    return;
  }

  await executeSSOSteps(sso, ctx);
}

export async function applyIntegration(
  input: ApplyIntegrationInput,
  onEvent: (event: InstallEvent) => void
): Promise<ApplyIntegrationResult> {
  const integration = await fetchIntegrationManifestFromSource(input.integrationId, input.sourceId);
  const reference = await fetchIntegrationManifestReferenceFromSource(input.integrationId, input.sourceId);
  const targetAppId = integration.target.appId;
  const targetMeta = await readInstallMetadata(targetAppId);
  if (!targetMeta) throw new Error(`Target app "${targetAppId}" is not installed`);

  const totalSteps = 4;
  let step = 1;
  emit(onEvent, step, totalSteps, 'running', `Loading ${integration.metadata.name}...`);

  const appManifest = await fetchManifestFromSource(targetAppId, targetMeta.sourceId || input.sourceId);
  const contextManifest = integrationContextManifest(appManifest, integration);
  const config = makeConfig(contextManifest, targetMeta);
  const secrets = await readAppSecrets(appManifest, targetAppId);
  emit(onEvent, step, totalSteps, 'success', 'Integration manifest loaded');

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Creating YouEye ID OAuth client...');
  const prelimCtx = await buildCanonicalContext(contextManifest, config, undefined, secrets.db_password, undefined, true);
  prelimCtx.secrets = secrets;
  const ssoResult = await ensureIntegrationOAuthClient(contextManifest, integration, config, prelimCtx);
  emit(onEvent, step, totalSteps, 'success', `${(await getIdentityProviderConfig()).name} OAuth client ready`);

  step++;
  emit(onEvent, step, totalSteps, 'running', `Configuring ${contextManifest.metadata.name}...`);
  const appToken = await generateAppToken(targetAppId);
  const ctx = await buildCanonicalContext(contextManifest, config, ssoResult, secrets.db_password, appToken, true);
  ctx.secrets = secrets;

  try {
    await executeIntegrationSetup(contextManifest, integration, ctx, targetMeta);
  } catch (err) {
    const errorContext = err instanceof StepError ? err.errorContext : undefined;
    onEvent({
      step,
      totalSteps,
      status: 'error',
      message: 'Integration configuration failed',
      detail: String(err),
      errorContext,
    });
    throw err;
  }
  emit(onEvent, step, totalSteps, 'success', `${integration.metadata.name} configured`);

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Recording integration metadata...');
  const installedAt = new Date().toISOString();
  const existing = targetMeta.installedIntegrations ?? [];
  targetMeta.installedIntegrations = [
    ...existing.filter((item) => item.id !== integration.metadata.id),
    {
      id: integration.metadata.id,
      sourceId: input.sourceId,
      sourceName: targetMeta.sourceName,
      manifestPath: reference.path,
      manifestRepo: reference.repo,
      manifestBranch: reference.branch,
      manifestDigest: reference.digest,
      installedAt,
    },
  ];
  targetMeta.selectedIntegrations = Array.from(new Set([...(targetMeta.selectedIntegrations ?? []), integration.metadata.id]));
  targetMeta.ssoSlug = targetMeta.ssoSlug || ssoResult?.slug;
  targetMeta.ssoClientId = targetMeta.ssoClientId || ssoResult?.clientId;
  targetMeta.enableSSO = targetMeta.enableSSO || Boolean(ssoResult);
  targetMeta.hasSSO = targetMeta.hasSSO || Boolean(ssoResult);
  await saveInstallMetadata(targetMeta);
  emit(onEvent, step, totalSteps, 'success', 'Integration metadata recorded');

  return {
    integrationId: integration.metadata.id,
    targetAppId,
    sourceId: input.sourceId,
    manifestDigest: reference.digest,
  };
}
