/**
 * Single User API
 *
 * PATCH  /api/people/[id] - Update user fields (isActive, isAdmin, name, email)
 * DELETE /api/people/[id] - Delete user. `?retainData=true` first retains (quarantines) the data apps keep private
 *   to the user, in every app (`retainUserPrivateData`); a user who administers or installed an app is still refused.
 *   A user with undecided apps or data is refused with 409 and the reason.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { deleteUser, getUser, updateUser } from '@/lib/identity/provider';
import { assertIdentityDisposition, isIdentityDispositionError } from '@/lib/identity/store';
import { admissionAdministrator, retainUserPrivateData } from '@/lib/admission/management';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { lifecycleRefusalResponse } from '@/lib/http/lifecycle-busy';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrf = request.headers.get('X-CSRF-Token');
    if (!csrf || !(await verifyCSRFToken(csrf))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const { isActive, isAdmin, firstName, lastName, email } = body as {
      isActive?: boolean;
      isAdmin?: boolean;
      firstName?: string;
      lastName?: string;
      email?: string;
    };

    const patch: Record<string, unknown> = {};
    if (typeof firstName === 'string') patch.firstName = firstName;
    if (typeof lastName === 'string') patch.lastName = lastName;
    if (typeof email === 'string') patch.email = email;
    if (typeof isActive === 'boolean') patch.is_active = isActive;
    if (typeof isAdmin === 'boolean') {
      const currentUser = await getUser(id);
      const currentGroups = currentUser.groups || [];
      patch.groups = isAdmin
        ? Array.from(new Set([...currentGroups, 'admin']))
        : currentGroups.filter((g: string) => g !== 'admin');
      patch.isAdmin = isAdmin;
    }

    const updated = await updateUser(id, patch as Parameters<typeof updateUser>[1]);
    return NextResponse.json({ user: updated, success: true });
  } catch (error) {
    if (isIdentityDispositionError(error)) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Refused', code: 'disposition_required' },
        { status: 409 });
    }
    console.error('Error updating user:', error);
    return NextResponse.json(
      { error: 'Failed to update user', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrf = request.headers.get('X-CSRF-Token');
    if (!csrf || !(await verifyCSRFToken(csrf))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { id } = await params;
    let retained: string[] = [];
    if (request.nextUrl.searchParams.get('retainData') === 'true') {
      const actorId = await admissionAdministrator(session);
      if (!actorId) return NextResponse.json({ error: 'Active administrator required' }, { status: 403 });
      // The appliance owner is refused before anything is retained.
      await assertIdentityDisposition(id, 'disable');
      // The deletion runs under the locks the retention took: a busy app refuses before anything is retained.
      retained = await withUserOperationLockWait(() => retainUserPrivateData(id, actorId, () => deleteUser(id)));
    } else {
      await deleteUser(id);
    }
    return NextResponse.json({ success: true, retainedDataApps: retained });
  } catch (error) {
    if (isIdentityDispositionError(error)) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Refused', code: 'disposition_required' },
        { status: 409 });
    }
    const refused = lifecycleRefusalResponse(error);
    if (refused) return refused;
    console.error('Error deleting user:', error);
    return NextResponse.json(
      { error: 'Failed to delete user', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
