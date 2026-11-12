import { getIdentityConfig } from './config';

const APP_CLIENT_PREFIX = 'youeye-app-';
const MANAGED_APP_IDENTITY_BASE = 'http://id.youeye:3002';

/** Managed app DNS maps this logical host to its current isolated bridge. */
export function getAppInternalIdentityBase(clientId: string): string | null {
  return clientId.startsWith(APP_CLIENT_PREFIX) ? MANAGED_APP_IDENTITY_BASE : null;
}

/** The same per-client issuer is used for discovery, ID tokens and logout tokens. */
export async function getClientIssuer(clientId: string): Promise<string> {
  const base = getAppInternalIdentityBase(clientId);
  if (base) return `${base}/application/o/${clientId}/`;
  const config = await getIdentityConfig();
  return `${config.externalUrl}/application/o/${clientId}/`;
}
