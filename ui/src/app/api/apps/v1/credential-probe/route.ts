import { validateAppToken } from '@/lib/auth/app-token';

/** The unready-generation probe exposes no platform or user data. */
export async function GET(request: Request) {
  const identity = await validateAppToken(request, 'probe');
  return identity
    ? Response.json({ ok: true, appId: identity.appId })
    : Response.json({ error: 'Unauthorized' }, { status: 401 });
}
