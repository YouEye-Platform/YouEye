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
import { addForwardAuthToRoute, removeForwardAuthFromRoute, resolveCaddyUpstreamDial } from '@/lib/caddy/client';
import { settingsService } from '@/lib/settings';

export type IdentityProvider = 'youeye-id';

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
  if (value === 'youeye-id') return value;
  throw new Error('Identity provider is not configured. Set identity.provider explicitly to youeye-id.');
}

/**
 * Guards the migration repair so it runs at most once per process. The original
 * bug logged "Repairing migrated config…" on EVERY request because the repair
 * write never took effect and the condition stayed true — so the warning (and a
 * config write) fired on every single call. This guard stops the re-check the
 * instant the repair has been attempted, whether or not the persisted value has
 * yet propagated back to this read.
 */
let providerRepairAttempted = false;
/** Set once we have proof the repair persisted (verified read-back). */
let providerRepairPersisted = false;

export async function getIdentityProvider(): Promise<IdentityProvider> {
  const raw = await settingsService.getRaw();
  const identity = raw.identity && typeof raw.identity === 'object'
    ? raw.identity as Record<string, unknown>
    : null;

  if (identity?.provider) {
    providerRepairAttempted = true;
    providerRepairPersisted = true;
    return normalizeProvider(identity.provider);
  }

  if (raw.subdomains?.identity) {
    // Migrated config with no explicit provider — youeye-id is the only provider
    // in this phase, so repair it. Do this ONCE, then stop re-checking.
    if (providerRepairAttempted) {
      return 'youeye-id';
    }
    providerRepairAttempted = true;

    console.warn('[identity] Repairing migrated config: setting identity.provider=youeye-id because subdomains.identity exists.');
    // Persist through Spine (single writer). This is awaited, not fire-and-forget:
    // a real transport failure propagates and fails loudly (no silent catch).
    await settingsService.setRaw({ identity: { ...(identity || {}), provider: 'youeye-id' } });
    settingsService.invalidate();

    // Verify the write actually landed. If Spine accepted the request but dropped
    // the nested identity key (silent no-op), log a loud, actionable error ONCE
    // — but do not throw or loop: the in-memory guard already stopped the spam
    // and youeye-id is the correct value regardless.
    try {
      const verify = await settingsService.getRaw();
      const verifyIdentity = verify.identity && typeof verify.identity === 'object'
        ? verify.identity as Record<string, unknown>
        : null;
      providerRepairPersisted = verifyIdentity?.provider === 'youeye-id';
    } catch (err) {
      console.error('[identity] Could not verify identity.provider repair persisted:', err);
    }
    if (!providerRepairPersisted) {
      console.error(
        '[identity] identity.provider=youeye-id repair did NOT persist — Spine accepted the PATCH but the nested identity key was not saved. Update Spine so PATCH /api/config persists nested objects; the value is applied in-memory for now.',
      );
    }
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
  const config = await getIdentityConfig();
  const raw = await settingsService.getRaw();
  const identitySettings = raw.identity && typeof raw.identity === 'object'
    ? raw.identity as Record<string, unknown>
    : {};
  const configuredName = typeof identitySettings.name === 'string' && identitySettings.name.trim()
    ? identitySettings.name.trim()
    : `${raw.site_name || 'YouEye'} ID`;
  return {
    provider,
    externalUrl: config.externalUrl,
    internalUrl: config.internalUrl,
    issuer: config.issuer,
    discoveryUrl: `${config.externalUrl}/.well-known/openid-configuration`,
    name: configuredName,
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
  await removeClient(clientId);
}

export async function configureForwardAuth(params: {
  hostname: string;
}): Promise<void> {
  const config = await getIdentityProviderConfig();
  await addForwardAuthToRoute(params.hostname, {
    upstreamDial: await resolveCaddyUpstreamDial(config.containerName, config.port),
    uri: '/forward-auth/caddy',
    copyHeaders: [
      'X-YouEye-Username',
      'X-YouEye-Groups',
      'X-YouEye-Email',
      'X-YouEye-Name',
      'X-YouEye-Uid',
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
  firstName: string;
  lastName: string;
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
  first_name: string;
  last_name: string;
  email: string;
  groups: string[];
  is_admin: boolean;
  is_active: boolean;
}): IdentityAdminUser {
  const groups = normalizeGroups(user.groups, user.is_admin);
  return {
    pk: user.id,
    id: user.id,
    username: user.username,
    name: user.name,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    is_active: user.is_active,
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
  const users = (await listIdentityUsers(params.search)).map(toAdminUser);
  return {
    pagination: { count: users.length, current: params.page || 1, total_pages: 1 },
    results: users,
  };
}

export async function getUser(id: string): Promise<IdentityAdminUser> {
  const user = await getUserById(id);
  if (!user) throw new Error(`Identity user not found: ${id}`);
  return toAdminUser(user);
}

export async function createUser(input: {
  username: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  groups?: string[];
  isAdmin?: boolean;
  is_active?: boolean;
}): Promise<IdentityAdminUser> {
  const password = input.password || randomBytes(24).toString('hex');
  return toAdminUser(await createIdentityUser({
    username: input.username,
    password,
    firstName: input.firstName ?? input.name ?? input.username,
    lastName: input.lastName ?? '',
    email: input.email,
    groups: normalizeGroups(input.groups, Boolean(input.isAdmin)),
    isAdmin: Boolean(input.isAdmin),
    isActive: input.is_active !== false,
  }));
}

export async function updateUser(id: string, input: {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  groups?: string[];
  isAdmin?: boolean;
  is_active?: boolean;
}): Promise<IdentityAdminUser> {
  const current = await getUserById(id);
  if (!current) throw new Error(`Identity user not found: ${id}`);
  const isAdmin = typeof input.isAdmin === 'boolean' ? input.isAdmin : current.is_admin;
  if (typeof input.is_active === 'boolean' && input.is_active !== current.is_active) {
    const { setPointerManagedActorState } = await import('@/lib/pointer/managed-apps');
    await setPointerManagedActorState(id, input.is_active ? 'active' : 'disabled');
  }
  return toAdminUser(await updateIdentityUser(id, {
    name: input.name,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    groups: input.groups ? normalizeGroups(input.groups, isAdmin) : undefined,
    isAdmin,
    isActive: input.is_active,
  }));
}

export async function deleteUser(id: string): Promise<void> {
  const current = await getUserById(id);
  if (!current) throw new Error(`Identity user not found: ${id}`);
  // Pause every app credential routed through this identity before the account
  // disappears. Pointer treats an unknown actor as an idempotent no-op, while
  // a known actor and all of their managed applications become unavailable.
  const { setPointerManagedActorState } = await import('@/lib/pointer/managed-apps');
  await setPointerManagedActorState(current.id, 'disabled');
  await deleteIdentityUser(id);
}

export async function setPassword(id: string, password: string): Promise<void> {
  await updateIdentityUser(id, { password });
}

export async function listGroups(): Promise<{ results: IdentityGroup[] }> {
  return {
    results: [
      { pk: 'youeye-users', name: 'youeye-users' },
      { pk: 'admin', name: 'admin' },
    ],
  };
}
