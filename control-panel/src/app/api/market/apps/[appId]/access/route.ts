import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { isLifecycleBusy, lifecycleBusyResponse } from '@/lib/http/lifecycle-busy';
import { NextRequest, NextResponse } from 'next/server';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getAdmissionPolicy, updateAdmissionPolicy } from '@/lib/admission/store';
import { admissionAdministrator, admissionManagementData, quarantineAdmissionData } from '@/lib/admission/management';
import { reconcileAdmissionProjections, admissionReconciliationState } from '@/lib/admission/projection';
import { installedAccessFacts, installedGateOnlyReason, recordOnlyUsers } from '@/lib/market/access-switch';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ appId: string }> };
export async function GET(_request: NextRequest, context: Context) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!await admissionAdministrator(auth.session)) return NextResponse.json({ error: 'Active administrator required' }, { status: 403 });
  const { appId } = await context.params;
  return NextResponse.json({ policy: await getAdmissionPolicy(appId),
    reconciliation: await admissionReconciliationState(appId),
    ...await installedAccessFacts(appId),
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
      await withUserOperationLockWait(() => quarantineAdmissionData({ appId, actorId, principalId: body.principalId, expectedRevision: body.expectedRevision }));
    } else {
      if (body.policy?.appId !== appId) return NextResponse.json({ error: 'Application mismatch' }, { status: 400 });
      // "Only <site> users" stays on for an app without a sign-in of its own (YE-154): opening it is refused.
      const gateOnly = body.policy?.publicAccess === true && !(await getAdmissionPolicy(appId))?.publicAccess
        ? await installedGateOnlyReason(appId) : null;
      if (gateOnly) {
        return NextResponse.json({ error: gateOnly === 'login-header'
          ? 'This app trusts the YouEye sign-in, so it stays for users only.'
          : 'This app has no sign-in of its own, so it stays for users only.', gateOnly }, { status: 409 });
      }
      await withUserOperationLockWait(() => updateAdmissionPolicy({ actorId, policy: body.policy, expectedRevision: body.expectedRevision }));
      // The install record's flag follows the switch for older readers; the policy above is what decides.
      await recordOnlyUsers(appId, body.policy.publicAccess !== true)
        .catch(error => logOperationFailure(`Access record of ${appId}`, error));
    }
    await reconcileAdmissionProjections().catch(error => logOperationFailure(`Access projection after a change to ${appId}`, error));
    const reconciliation = await admissionReconciliationState(appId);
    return NextResponse.json({ policy: await getAdmissionPolicy(appId), reconciliation,
      ...await installedAccessFacts(appId),
      ...await admissionManagementData(appId) }, { status: reconciliation === 'pending' ? 202 : 200 });
  } catch (error) {
    if (!isLifecycleBusy(error)) logOperationFailure(`Access change for ${appId}`, error);
    return lifecycleBusyResponse(error)
      ?? NextResponse.json({ error: error instanceof Error ? error.message : 'Admission update failed' }, { status: 409 });
  }
}
