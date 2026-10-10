import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { appServiceCredentials } from '@/lib/apps/service-credential-store';
import { operateAppCredential } from '@/lib/apps/service-credential-operations';
import type { AppCredentialLifecycleAction } from '@/lib/apps/service-credential-lifecycle';

type Context = { params: Promise<{ appId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const { appId } = await params;
    return Response.json({ credential: await appServiceCredentials.status(appId) });
  } catch {
    return Response.json({ error: 'App credential requires reconciliation' }, { status: 409 });
  }
}

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!await verifyCSRFToken(request.headers.get('x-csrf-token') ?? '')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  let operation: AppCredentialLifecycleAction;
  try {
    const text = await request.text();
    if (text.length > 4096) throw new Error('Oversized action');
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid action');
    if (['provision', 'reconcile'].includes(body.action) && Object.keys(body).length === 1) {
      operation = body;
    } else if (['rotate', 'revoke', 'reinstall'].includes(body.action)
      && Object.keys(body).sort().join(',') === 'action,expectedRevision'
      && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision > 0) {
      operation = body;
    } else throw new Error('Invalid action');
  } catch {
    return Response.json({ error: 'Invalid credential action' }, { status: 400 });
  }
  try {
    const { appId } = await params;
    return Response.json({ credential: await operateAppCredential(appId, operation) });
  } catch {
    return Response.json({ error: 'App service integration is pending; reconcile credentials' }, { status: 409 });
  }
}
