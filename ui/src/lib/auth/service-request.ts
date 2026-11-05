import { hasAppServiceAuthHeaders } from '../../../../shared/app-service-credential';

/** An explicit machine authentication attempt cannot acquire browser authority. */
export function hasMachineAuthHeaders(headers: Headers): boolean {
  return hasAppServiceAuthHeaders(headers);
}

export async function resolveBrowserSession<T>(
  headers: Headers,
  readSession: () => Promise<T | null>,
): Promise<T | null> {
  return hasMachineAuthHeaders(headers) ? null : readSession();
}

export interface AppServiceUser {
  id: string;
  identityId: string | null;
  username: string | null;
  name: string | null;
  email: string | null;
}

/** App credentials authenticate the app; they never confer administrator auth. */
export async function resolveAppServiceUser(
  headers: Headers,
  validateApp: () => Promise<{ appId: string } | null>,
  findUser: (stableId: string) => Promise<AppServiceUser | null>,
  admitUser: (appId: string, identityId: string) => boolean | Promise<boolean>,
) {
  const claimedApp = headers.get('x-youeye-app');
  const actingUser = headers.get('x-youeye-user');
  if (!claimedApp || !actingUser || headers.has('x-ui-bridge-token')) return null;
  try {
    const app = await validateApp();
    if (!app || app.appId !== claimedApp) return null;
    const user = await findUser(actingUser);
    if (!user?.identityId || !await admitUser(app.appId, user.identityId)) return null;
    return {
      id: user.id, identityId: user.identityId, appId: app.appId,
      username: user.username ?? '', name: user.name ?? user.username ?? '',
      email: user.email ?? '', isAdmin: false,
    };
  } catch {
    return null;
  }
}
