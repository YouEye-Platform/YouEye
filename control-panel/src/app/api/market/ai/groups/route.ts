import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { getUserByUsername } from '@/lib/identity/store';
import { listPointerActorGroups } from '@/lib/pointer/managed-apps';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const user = await getUserByUsername(auth.session.username);
  if (!user) {
    return NextResponse.json(
      { error: 'AI Settings require a YouEye user account' },
      { status: 400 },
    );
  }
  try {
    const groups = await listPointerActorGroups({
      id: user.id,
      name: user.name || user.username,
      isAdmin: user.is_admin,
    });
    return NextResponse.json({
      groups,
      defaultGroupId: groups.find((group) => group.isDefault)?.id ?? null,
    });
  } catch {
    return NextResponse.json(
      { error: 'AI model groups are unavailable' },
      { status: 503 },
    );
  }
}
