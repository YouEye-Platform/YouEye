/**
 * Single User API
 *
 * PATCH  /api/people/[id] - Update user fields (isActive, isAdmin, name, email)
 * DELETE /api/people/[id] - Delete user
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { updateUser, deleteUser, getUser, listGroups } from '@/lib/authentik/client';

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
    const userId = parseInt(id, 10);
    if (isNaN(userId)) {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    const body = await request.json();
    const { isActive, isAdmin, name, email } = body as {
      isActive?: boolean;
      isAdmin?: boolean;
      name?: string;
      email?: string;
    };

    const patch: Record<string, unknown> = {};
    if (typeof name === 'string') patch.name = name;
    if (typeof email === 'string') patch.email = email;
    if (typeof isActive === 'boolean') patch.is_active = isActive;

    // Handle admin toggle via group membership
    if (typeof isAdmin === 'boolean') {
      const currentUser = await getUser(userId);
      const groups = await listGroups({ search: 'authentik Admins', page_size: 5 });
      const adminGroup = groups.results.find(g => g.name === 'authentik Admins');

      if (adminGroup) {
        const currentGroups = currentUser.groups || [];
        if (isAdmin && !currentGroups.includes(adminGroup.pk)) {
          patch.groups = [...currentGroups, adminGroup.pk];
        } else if (!isAdmin) {
          patch.groups = currentGroups.filter((g: string) => g !== adminGroup.pk);
        }
      }
    }

    const updated = await updateUser(userId, patch as Parameters<typeof updateUser>[1]);
    return NextResponse.json({ user: updated, success: true });
  } catch (error) {
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
    const userId = parseInt(id, 10);
    if (isNaN(userId)) {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    await deleteUser(userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    return NextResponse.json(
      { error: 'Failed to delete user', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
