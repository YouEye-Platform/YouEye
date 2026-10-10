import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getAdmissionPolicy, updateAdmissionPolicy } from '@/lib/admission/store';
import { admissionAdministrator, admissionManagementData, quarantineAdmissionData } from '@/lib/admission/management';
import { reconcileAdmissionProjections, admissionReconciliationState } from '@/lib/admission/projection';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ appId: string }> };
export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!await admissionAdministrator(auth.session)) return NextResponse.json({ error: 'Active administrator required' }, { status: 403 });
  const { appId } = await context.params;
  return NextResponse.json({ policy: await getAdmissionPolicy(appId),
    reconciliation: await admissionReconciliationState(appId),
    ...await admissionManagementData(appId) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function PUT(request: NextRequest, context: Context) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const actorId = await admissionAdministrator(auth.session);
  if (!actorId) return NextResponse.json({ error: 'Active administrator required' }, { status: 403 });
  const { appId } = await context.params;
  try {
    const body = await request.json();
    if (body.action === 'retain_quarantined') {
      await quarantineAdmissionData({ appId, actorId, principalId: body.principalId, expectedRevision: body.expectedRevision });
    } else {
      if (body.policy?.appId !== appId) return NextResponse.json({ error: 'Application mismatch' }, { status: 400 });
      await updateAdmissionPolicy({ actorId, policy: body.policy, expectedRevision: body.expectedRevision });
    }
    await reconcileAdmissionProjections().catch(() => undefined);
    const reconciliation = await admissionReconciliationState(appId);
    return NextResponse.json({ policy: await getAdmissionPolicy(appId), reconciliation,
      ...await admissionManagementData(appId) }, { status: reconciliation === 'pending' ? 202 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Admission update failed' }, { status: 409 });
  }
}
