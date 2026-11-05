import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getAppUpdateOperation, recoverAppUpdateOperation } from '@/lib/market/update-operations';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') || ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.appId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.appId)
    || typeof body.id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.id)) {
    return NextResponse.json({ error: 'Invalid recovery request' }, { status: 400 });
  }
  try {
    const operation = getAppUpdateOperation(body.appId);
    if (!operation) {
      return NextResponse.json({ error: 'Update operation not found' }, { status: 404 });
    }
    if (operation.id !== body.id) {
      return NextResponse.json({ error: 'Operation changed. Refresh its status before retrying.' }, { status: 409 });
    }
    // Repeated verified cleanup acknowledges its health issue without replaying
    // provider effects; the operation helper protects newer unfinished work.
    await recoverAppUpdateOperation(body.appId, body.id);
    return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Includes a live executor's busy lock; keep the operation and checkpoints.
    return NextResponse.json({
      error: 'Recovery could not complete. The operation may still be running. Refresh its status before retrying.',
      code: 'recovery_pending',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
}
