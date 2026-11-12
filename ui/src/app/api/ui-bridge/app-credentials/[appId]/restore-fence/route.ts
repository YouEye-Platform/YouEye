import { getBridgeToken } from '@/lib/admin/bridge-client';
import { authorizeCredentialBridge } from '@/lib/auth/app-credential-readiness';
import { AppCredentialPublicationConflict } from '@/lib/auth/app-credential-publication';
import { readAppCredentialProjection, publishAppCredentialRestoreFence } from '@/lib/db/queries/app-service-credentials';
import { isCanonicalAppId, parseAppCredentialProjection } from '../../../../../../../../shared/app-service-credential';

type Context = { params: Promise<{ appId: string }> };

/** Protected restore transport exposes verifier metadata only to CP. */
export async function GET(request: Request, { params }: Context) {
  if (!authorizeCredentialBridge(request, getBridgeToken())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { appId } = await params;
  if (!isCanonicalAppId(appId)) return Response.json({ error: 'Invalid identity' }, { status: 400 });
  try { return Response.json({ credential: await readAppCredentialProjection(appId) }); }
  catch { return Response.json({ error: 'Verifier unavailable' }, { status: 503 }); }
}

/** A revision gap can establish revocation only; it never grants runtime access. */
export async function POST(request: Request, { params }: Context) {
  if (!authorizeCredentialBridge(request, getBridgeToken())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { appId } = await params;
  let credential, expected;
  try {
    if (!isCanonicalAppId(appId)) throw new Error('Invalid identity');
    const text = await request.text();
    if (text.length > 4096) throw new Error('Oversized fence');
    const body = JSON.parse(text);
    if (!body || Object.keys(body).sort().join(',') !== 'credential,expected') throw new Error('Invalid envelope');
    credential = parseAppCredentialProjection(body.credential);
    expected = body.expected === null ? null : parseAppCredentialProjection(body.expected);
    if (credential.status !== 'revoked' || credential.appId !== appId
      || (expected && expected.appId !== appId)) throw new Error('Invalid identity');
  } catch { return Response.json({ error: 'Invalid restore fence' }, { status: 400 }); }
  try {
    await publishAppCredentialRestoreFence(credential, expected);
    return Response.json({ ok: true, revision: credential.revision });
  } catch (error) {
    return Response.json({ error: 'Restore fence requires reconciliation' },
      { status: error instanceof AppCredentialPublicationConflict ? 409 : 503 });
  }
}
