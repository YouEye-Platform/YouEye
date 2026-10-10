/**
 * Testable bridge publication handler. Browser and application credentials
 * never authorize lifecycle changes, even when a browser session is present.
 */
import {
  isCanonicalAppId,
  parseAppCredentialProjection,
  type AppCredentialProjection,
} from '../../../../shared/app-service-credential';

export class AppCredentialPublicationConflict extends Error {
  constructor() { super('App credential publication conflict'); }
}

export interface AppCredentialPublisher {
  authorizeBridge(request: Request): boolean;
  publish(credential: AppCredentialProjection, expectedRevision: number): Promise<'apply' | 'unchanged'>;
  publishBatch?(credentials: AppCredentialProjection[], expectedRevision: number): Promise<'apply' | 'unchanged'>;
}

export async function handleAppCredentialPublication(
  request: Request,
  appId: string,
  publisher: AppCredentialPublisher,
): Promise<Response> {
  if (!publisher.authorizeBridge(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCanonicalAppId(appId)) {
    return Response.json({ error: 'Invalid app credential publication' }, { status: 400 });
  }
  let credential: AppCredentialProjection;
  let credentials: AppCredentialProjection[];
  let expectedRevision: number;
  try {
    const text = await request.text();
    if (text.length > 16_384) throw new Error('Oversized publication');
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !['credential,expectedRevision', 'credentials,expectedRevision'].includes(Object.keys(body).sort().join(','))
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new Error('Invalid publication envelope');
    }
    expectedRevision = body.expectedRevision;
    const values = 'credentials' in body ? body.credentials : [body.credential];
    if (!Array.isArray(values) || !values.length || values.length > 24) throw new Error('Invalid publication batch');
    credentials = values.map(parseAppCredentialProjection);
    credential = credentials[credentials.length - 1];
    if (credentials.some(value => value.appId !== appId)) throw new Error('Mismatched publication identity');
  } catch {
    return Response.json({ error: 'Invalid app credential publication' }, { status: 400 });
  }
  try {
    const result = credentials.length === 1
      ? await publisher.publish(credential, expectedRevision)
      : await publisher.publishBatch?.(credentials, expectedRevision);
    if (!result) throw new Error('Batch publication unavailable');
    return Response.json({
      ok: true, result, appId, installationId: credential.installationId,
      generation: credential.generation, revision: credential.revision, status: credential.status,
    });
  } catch (error) {
    if (error instanceof AppCredentialPublicationConflict) {
      return Response.json({ error: 'App credential publication conflict' }, { status: 409 });
    }
    return Response.json({ error: 'App credential verifier is unavailable' }, { status: 503 });
  }
}
