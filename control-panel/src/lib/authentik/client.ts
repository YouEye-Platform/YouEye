/**
 * Authentik API v3 Client
 *
 * Server-side client that communicates with the Authentik container
 * via its internal IP. Uses the bootstrap token from Spine for auth.
 */

import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';

let cachedToken: string | null = null;
let cachedUrl: string | null = null;

async function getAuthentikConfig(): Promise<{ url: string; token: string }> {
  if (cachedToken && cachedUrl) {
    return { url: cachedUrl, token: cachedToken };
  }

  const creds = await spineClient.getAuthentikCredentials();
  cachedToken = creds.bootstrap_token;

  // Use container IP directly instead of relying on Spine's stored URL
  const ip = await getContainerIP('youeye-authentik');
  cachedUrl = ip ? `http://${ip}:9000` : creds.internal_url;

  return { url: cachedUrl, token: cachedToken };
}

/**
 * Make an authenticated request to the Authentik API v3
 */
async function authentikRequest<T>(
  path: string,
  method: string = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  const { url, token } = await getAuthentikConfig();
  const fullUrl = `${url}/api/v3${path}`;

  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(fullUrl, options);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Authentik API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// --- Types ---

export interface AuthentikUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  type: string;
  groups: string[];
  groups_obj?: Array<{ pk: string; name: string }>;
  last_login?: string;
  uid: string;
  path: string;
}

export interface AuthentikGroup {
  pk: string;
  name: string;
  is_superuser: boolean;
  users: number[];
  users_obj?: Array<{ pk: number; username: string }>;
  num_pk: number;
}

interface PaginatedResponse<T> {
  pagination: { count: number; current: number; total_pages: number };
  results: T[];
}

export interface AuthentikConfig {
  version: string;
  version_current: string;
  build_hash: string;
  error_reporting: { enabled: boolean };
}

// --- API Functions ---

/**
 * Get Authentik system config (version, etc.)
 */
export async function getConfig(): Promise<AuthentikConfig> {
  return authentikRequest('/root/config/');
}

/**
 * List users
 */
export async function listUsers(
  params?: { search?: string; page?: number; page_size?: number }
): Promise<PaginatedResponse<AuthentikUser>> {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set('search', params.search);
  if (params?.page) searchParams.set('page', String(params.page));
  searchParams.set('page_size', String(params?.page_size || 50));

  const qs = searchParams.toString();
  return authentikRequest(`/core/users/?${qs}`);
}

/**
 * Create a new user
 */
export async function createUser(data: {
  username: string;
  name: string;
  email?: string;
  is_active?: boolean;
  groups?: string[];
}): Promise<AuthentikUser> {
  return authentikRequest('/core/users/', 'POST', {
    ...data,
    is_active: data.is_active ?? true,
    path: 'users',
    type: 'internal',
  });
}

/**
 * Get a single user
 */
export async function getUser(id: number): Promise<AuthentikUser> {
  return authentikRequest(`/core/users/${id}/`);
}

/**
 * Update a user
 */
export async function updateUser(
  id: number,
  data: Partial<{ username: string; name: string; email: string; is_active: boolean; groups: string[] }>
): Promise<AuthentikUser> {
  return authentikRequest(`/core/users/${id}/`, 'PATCH', data);
}

/**
 * Delete a user
 */
export async function deleteUser(id: number): Promise<void> {
  await authentikRequest(`/core/users/${id}/`, 'DELETE');
}

/**
 * Set a user's password
 */
export async function setUserPassword(id: number, password: string): Promise<void> {
  await authentikRequest(`/core/users/${id}/set_password/`, 'POST', { password });
}

/**
 * List groups
 */
export async function listGroups(
  params?: { search?: string; page_size?: number }
): Promise<PaginatedResponse<AuthentikGroup>> {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set('search', params.search);
  searchParams.set('page_size', String(params?.page_size || 50));

  const qs = searchParams.toString();
  return authentikRequest(`/core/groups/?${qs}`);
}

/**
 * Create a group
 */
export async function createGroup(data: {
  name: string;
  is_superuser?: boolean;
  users?: number[];
}): Promise<AuthentikGroup> {
  return authentikRequest('/core/groups/', 'POST', data);
}

/**
 * Delete a group
 */
export async function deleteGroup(id: string): Promise<void> {
  await authentikRequest(`/core/groups/${id}/`, 'DELETE');
}

/**
 * Clear cached credentials (useful after restart)
 */
export function clearCache(): void {
  cachedToken = null;
  cachedUrl = null;
}

// --- Brands API ---

export interface AuthentikBrand {
  pk: string;
  brand_uuid: string;
  branding_title: string;
  branding_logo: string;
  branding_favicon: string;
  branding_custom_css: string;
  branding_default_flow_background: string;
  flow_authentication: string;
  flow_invalidation: string;
  default: boolean;
  attributes: Record<string, unknown>;
}

/**
 * List all brands (tenants)
 */
export async function listBrands(): Promise<PaginatedResponse<AuthentikBrand>> {
  return authentikRequest('/core/brands/');
}

/**
 * Update a brand's branding settings
 */
export async function updateBrand(
  brandUuid: string,
  data: Partial<{
    branding_title: string;
    branding_logo: string;
    branding_favicon: string;
    branding_custom_css: string;
    branding_default_flow_background: string;
  }>
): Promise<AuthentikBrand> {
  return authentikRequest(`/core/brands/${brandUuid}/`, 'PATCH', data);
}

/**
 * Update a flow's settings (layout, title, etc.)
 */
export async function updateFlow(
  slug: string,
  data: Partial<{ layout: string; title: string; background: string }>
): Promise<unknown> {
  return authentikRequest(`/flows/instances/${slug}/`, 'PATCH', data);
}

/**
 * Ensure Authentik uses attributes.avatar for custom user avatars.
 * Falls back to gravatar then initials if no custom avatar is set.
 */
export async function ensureAvatarSettings(): Promise<void> {
  try {
    const settings = await authentikRequest<{ avatars: string }>('/admin/settings/');
    if (!settings.avatars?.includes('attributes.avatar')) {
      await authentikRequest('/admin/settings/', 'PATCH', {
        avatars: 'attributes.avatar,gravatar,initials',
      });
    }
  } catch {
    // Non-fatal — avatar settings may already be correct
  }
}
