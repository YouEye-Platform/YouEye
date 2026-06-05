import { randomBytes } from 'crypto';
import { getIdentityConfig } from './config';
import { ensureClient, removeClient } from './store';
import { addForwardAuthToRoute, removeForwardAuthFromRoute } from '@/lib/caddy/client';
import { settingsService } from '@/lib/settings';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

export type IdentityProvider = 'youeye-id' | 'authentik';

export interface IdentityProviderConfig {
  provider: IdentityProvider;
  externalUrl: string;
  internalUrl: string;
  issuer: string;
  discoveryUrl: string;
  name: string;
  containerName: string;
  port: number;
}

function normalizeProvider(value: unknown): IdentityProvider {
  if (value === 'youeye-id' || value === 'authentik') return value;
  throw new Error('Identity provider is not configured. Set identity.provider explicitly to youeye-id or authentik.');
}

export async function getIdentityProvider(): Promise<IdentityProvider> {
  const raw = await settingsService.getRaw();
  const identity = raw.identity && typeof raw.identity === 'object'
    ? raw.identity as Record<string, unknown>
    : null;
  if (!identity?.provider && raw.subdomains?.identity) {
    console.warn('[identity] Repairing migrated config: setting identity.provider=youeye-id because subdomains.identity exists.');
    await settingsService.setRaw({ identity: { ...(identity || {}), provider: 'youeye-id' } });
    return 'youeye-id';
  }
  return normalizeProvider(identity?.provider);
}

export async function setIdentityProvider(provider: IdentityProvider): Promise<void> {
  const raw = await settingsService.getRaw();
  await settingsService.setRaw({
    identity: {
      ...(raw.identity || {}),
      provider,
    },
  });
}

export async function getIdentityProviderConfig(): Promise<IdentityProviderConfig> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error('The provider-neutral identity layer is currently wired for youeye-id only in this phase.');
  }

  const config = await getIdentityConfig();
  return {
    provider,
    externalUrl: config.externalUrl,
    internalUrl: config.internalUrl,
    issuer: config.issuer,
    discoveryUrl: `${config.externalUrl}/.well-known/openid-configuration`,
    name: 'YouEye ID',
    containerName: config.containerName,
    port: config.port,
  };
}

export async function createOAuthClient(params: {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes?: string[];
  clientSecret?: string;
}): Promise<{ clientId: string; clientSecret: string }> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`OAuth client creation for provider ${provider} is not implemented in the provider-neutral layer.`);
  }

  const clientSecret = params.clientSecret || randomBytes(32).toString('hex');
  const client = await ensureClient({
    clientId: params.clientId,
    clientSecret,
    name: params.name,
    redirectUris: params.redirectUris,
    scopes: params.scopes || ['openid', 'profile', 'email', 'groups'],
  });

  return { clientId: client.client_id, clientSecret: client.client_secret };
}

export async function removeOAuthClient(clientId: string): Promise<void> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`OAuth client removal for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  await removeClient(clientId);
}

export async function configureForwardAuth(params: {
  hostname: string;
}): Promise<void> {
  const config = await getIdentityProviderConfig();
  await addForwardAuthToRoute(params.hostname, {
    upstreamDial: `${config.containerName}.${CONTAINER_DOMAIN}:${config.port}`,
    uri: '/forward-auth/caddy',
    copyHeaders: [
      'X-YouEye-Username',
      'X-YouEye-Groups',
      'X-YouEye-Email',
      'X-YouEye-Name',
      'X-YouEye-Uid',
      'X-Authentik-Username',
      'X-Authentik-Groups',
      'X-Authentik-Email',
      'X-Authentik-Name',
      'X-Authentik-Uid',
    ],
  });
}

export async function removeForwardAuth(params: { hostname: string }): Promise<void> {
  await removeForwardAuthFromRoute(params.hostname);
}
