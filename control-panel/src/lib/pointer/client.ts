import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { getUserById } from '@/lib/identity/store';
import { createPointerManagementAssertion } from '@/lib/identity/tokens';
import type { SessionPayload } from '@/lib/auth/session';

export const POINTER_CONTAINER = 'youeye-pointer';
export const POINTER_MANAGEMENT_BASE = `http://${POINTER_CONTAINER}.${CONTAINER_DOMAIN}:4001`;
export const POINTER_INFERENCE_PORT = 4002;

import { allowedPointerManagementPath } from './management-path';
export { allowedPointerManagementPath } from './management-path';

export async function pointerAssertionForSession(session: SessionPayload) {
  if (session.authMethod === 'pam' || session.authMethod === 'cli') {
    throw new Error('AI settings require a YouEye user account');
  }
  const user = await getUserById(session.identityId ?? "");
  if (!user?.is_active || user.id !== session.identityId) throw new Error('Active YouEye identity account was not found');
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
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
}
