import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { getUserByUsername } from '@/lib/identity/store';
import { createPointerManagementAssertion } from '@/lib/identity/tokens';
import type { SessionPayload } from '@/lib/auth/session';

export const POINTER_CONTAINER = 'youeye-pointer';
export const POINTER_MANAGEMENT_BASE = `http://${POINTER_CONTAINER}.${CONTAINER_DOMAIN}:4001`;
export const POINTER_INFERENCE_PORT = 4002;

const PERSONAL_PREFIXES = [
  '/api/providers',
  '/api/provider-accounts',
  '/api/catalog',
  '/api/groups',
  '/api/instances',
  '/api/keys',
  '/api/stats',
  '/api/test-model',
];

export function allowedPointerManagementPath(path: string) {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://pointer.internal').pathname;
  } catch {
    return false;
  }
  return PERSONAL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function pointerAssertionForSession(session: SessionPayload) {
  if (session.authMethod === 'pam' || session.authMethod === 'cli') {
    throw new Error('AI settings require a YouEye user account');
  }
  const user = await getUserByUsername(session.username);
  if (!user) throw new Error('YouEye identity account was not found');
  return createPointerManagementAssertion(user);
}

export async function pointerManagementFetch(
  session: SessionPayload,
  path: string,
  init: RequestInit = {},
) {
  if (!allowedPointerManagementPath(path)) throw new Error('Pointer management path is not allowed');
  const assertion = await pointerAssertionForSession(session);
  return fetch(`${POINTER_MANAGEMENT_BASE}${path}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${assertion}`,
      'x-request-id': crypto.randomUUID(),
    },
    cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
}
