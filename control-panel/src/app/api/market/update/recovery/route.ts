import { type NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getAppUpdateOperation, recoverAppUpdateOperation } from '@/lib/market/update-operations';
import { logOperationFailure } from '@/lib/market/install-tracker';

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
  } catch (error) {
    // The operation and its checkpoints are kept either way. Say what happened: a live executor (busy lock) is not a
    // failure; anything else is logged with its full cause (never serialized: provider errors can hold secrets).
    logOperationFailure(`Recovery of the ${body.appId} update ${body.id}`, error);
    const busy = error instanceof Error && /LockBusy|lock is busy/i.test(`${error.name} ${error.message}`);
    return NextResponse.json(busy ? {
      error: 'The update is still running. Try again in a moment.', code: 'operation_in_progress',
    } : {
      error: 'Recovery did not finish; the cause is in the Control Panel journal (journalctl in youeye-control).',
      code: 'recovery_failed',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
}
