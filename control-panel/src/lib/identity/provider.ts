import { randomBytes } from 'crypto';
import { getIdentityConfig } from './config';
import {
  createIdentityUser,
  deleteIdentityUser,
  ensureClient,
  getUserById,
  listIdentityUsers,
  removeClient,
  updateIdentityUser,
} from './store';
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

export interface IdentityGroup {
  pk: string;
  name: string;
}

export interface IdentityAdminUser {
  pk: string;
  id: string;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  groups: string[];
  groups_obj: IdentityGroup[];
  type: string;
  last_login: string | null;
}

function normalizeGroups(groups: string[] | undefined, isAdmin: boolean): string[] {
  const next = new Set(groups || []);
  if (isAdmin) next.add('admin');
  if (next.size === 0) next.add('youeye-users');
  return [...next];
}

function toAdminUser(user: {
  id: string;
  username: string;
  name: string;
  email: string;
  groups: string[];
  is_admin: boolean;
}): IdentityAdminUser {
  const groups = normalizeGroups(user.groups, user.is_admin);
  return {
    pk: user.id,
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    is_active: true,
    is_superuser: user.is_admin || groups.includes('admin'),
    groups,
    groups_obj: groups.map((group) => ({ pk: group, name: group })),
    type: 'user',
    last_login: null,
  };
}

export async function listUsers(params: { search?: string; page_size?: number; page?: number } = {}): Promise<{
  pagination: { count: number; current: number; total_pages: number };
  results: IdentityAdminUser[];
}> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`User listing for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  const users = (await listIdentityUsers(params.search)).map(toAdminUser);
  return {
    pagination: { count: users.length, current: params.page || 1, total_pages: 1 },
    results: users,
  };
}

export async function getUser(id: string): Promise<IdentityAdminUser> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`User lookup for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  const user = await getUserById(id);
  if (!user) throw new Error(`Identity user not found: ${id}`);
  return toAdminUser(user);
}

export async function createUser(input: {
  username: string;
  name: string;
  email?: string;
  password?: string;
  groups?: string[];
  isAdmin?: boolean;
  is_active?: boolean;
}): Promise<IdentityAdminUser> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`User creation for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  const password = input.password || randomBytes(24).toString('hex');
  return toAdminUser(await createIdentityUser({
    username: input.username,
    password,
    name: input.name,
    email: input.email,
    groups: normalizeGroups(input.groups, Boolean(input.isAdmin)),
    isAdmin: Boolean(input.isAdmin),
  }));
}

export async function updateUser(id: string, input: {
  name?: string;
  email?: string;
  groups?: string[];
  isAdmin?: boolean;
  is_active?: boolean;
}): Promise<IdentityAdminUser> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`User update for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  const current = await getUserById(id);
  if (!current) throw new Error(`Identity user not found: ${id}`);
  const isAdmin = typeof input.isAdmin === 'boolean' ? input.isAdmin : current.is_admin;
  return toAdminUser(await updateIdentityUser(id, {
    name: input.name,
    email: input.email,
    groups: input.groups ? normalizeGroups(input.groups, isAdmin) : undefined,
    isAdmin,
  }));
}

export async function deleteUser(id: string): Promise<void> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`User deletion for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  await deleteIdentityUser(id);
}

export async function setPassword(id: string, password: string): Promise<void> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`Password updates for provider ${provider} are not implemented in the provider-neutral layer.`);
  }
  await updateIdentityUser(id, { password });
}

export async function listGroups(): Promise<{ results: IdentityGroup[] }> {
  const provider = await getIdentityProvider();
  if (provider !== 'youeye-id') {
    throw new Error(`Group listing for provider ${provider} is not implemented in the provider-neutral layer.`);
  }
  return {
    results: [
      { pk: 'youeye-users', name: 'youeye-users' },
      { pk: 'admin', name: 'admin' },
      { pk: 'authentik Admins', name: 'authentik Admins' },
    ],
  };
}
