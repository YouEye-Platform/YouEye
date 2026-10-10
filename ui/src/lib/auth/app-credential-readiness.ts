import { timingSafeEqual } from 'node:crypto';
import { isCanonicalAppId } from '../../../../shared/app-service-credential';
import { AppCredentialPublicationConflict } from './app-credential-publication';

export interface AppCredentialReadinessReceipt {
  installationId: string;
  generation: number;
  revision: number;
  ready?: boolean;
}

export function authorizeCredentialBridge(request: Request, expected: string | null | undefined): boolean {
  const provided = request.headers.get('x-ui-bridge-token');
  // App credentials and bridge authority are separate even in mixed requests.
  if (!provided || !expected || request.headers.has('authorization')
    || request.headers.has('x-youeye-app') || request.headers.has('x-youeye-user')
    || request.headers.has('x-app-slug')) return false;
  const actual = Buffer.from(provided);
  const stored = Buffer.from(expected);
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

export async function handleAppCredentialReadiness(
  request: Request,
  appId: string,
  authorize: (request: Request) => boolean,
  markReady: (appId: string, receipt: AppCredentialReadinessReceipt) => Promise<void>,
): Promise<Response> {
  if (!authorize(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: AppCredentialReadinessReceipt;
  try {
    if (!isCanonicalAppId(appId)) throw new Error('Invalid identity');
    const text = await request.text();
    if (text.length > 4096) throw new Error('Oversized receipt');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['generation,installationId,revision', 'generation,installationId,ready,revision'].includes(Object.keys(value).sort().join(','))
      || ('ready' in value && typeof value.ready !== 'boolean')
      || typeof value.installationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.installationId)
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('Invalid receipt');
    body = value;
  } catch {
    return Response.json({ error: 'Invalid readiness receipt' }, { status: 400 });
  }
  try {
    await markReady(appId, body);
    return Response.json({ ok: true });
  } catch (error) {
    return error instanceof AppCredentialPublicationConflict
      ? Response.json({ error: 'App credential readiness conflict' }, { status: 409 })
      : Response.json({ error: 'App credential verifier is unavailable' }, { status: 503 });
  }
}
