import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { readRetainedInstallMetadata } from '@/lib/market/metadata';
import { getAdmissionPolicy, getAdmissionPrincipals } from '@/lib/admission/store';

export async function GET(_request: Request, context: { params: Promise<{ appId: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { appId } = await context.params;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) return NextResponse.json({ error: 'Invalid app' }, { status: 400 });
  try {
    const retained = await readRetainedInstallMetadata(appId);
    if (!retained) return NextResponse.json({ retained: false });
    const policy = await getAdmissionPolicy(appId);
    const actor = (await getAdmissionPrincipals()).find(p => p.id === auth.session.identityId);
    return NextResponse.json({
      retained: true, version: retained.installedVersion,
      canAdopt: policy?.state === 'retained' && policy.installationId === retained.installationId
        && policy.ownerId === actor?.id && actor.active && !actor.deleted
        && retained.retainedRoots?.state === 'ready',
      message: 'Retained data belongs to its original data owners. Only the active app owner can explicitly adopt the original app version.',
    });
  } catch {
    return NextResponse.json({ error: 'Retained data needs ownership recovery' }, { status: 409 });
  }
}
