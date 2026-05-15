/**
 * UI Bridge: User Actions
 *
 * PUT    /api/ui-bridge/users/:id  — update user (password, toggle-active, toggle-admin)
 * DELETE /api/ui-bridge/users/:id  — delete user
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import {
  getUser,
  updateUser,
  deleteUser,
  setUserPassword,
  listGroups,
} from '@/lib/authentik/client';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) {
    return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { action, password } = body;

    switch (action) {
      case 'set-password': {
        if (!password) {
          return NextResponse.json({ error: 'password is required' }, { status: 400 });
        }
        await setUserPassword(userId, password);
        return NextResponse.json({ success: true });
      }

      case 'toggle-active': {
        const user = await getUser(userId);
        await updateUser(userId, { is_active: !user.is_active });
        return NextResponse.json({ success: true, is_active: !user.is_active });
      }

      case 'toggle-admin': {
        const user = await getUser(userId);
        // Find or create Admins group
        const groupsResult = await listGroups({ search: 'Admins', page_size: 50 });
        const adminsGroup = groupsResult.results.find((g) => g.name === 'Admins');

        if (!adminsGroup) {
          return NextResponse.json(
            { error: 'Admins group not found in Authentik' },
            { status: 500 }
          );
        }

        if (user.is_superuser) {
          // Remove from Admins group
          const newUsers = adminsGroup.users.filter((uid) => uid !== userId);
          await updateUser(userId, { groups: [adminsGroup.pk] });
          // Use PATCH to remove user from group by updating user's groups
          const currentGroups = user.groups.filter((g) => g !== adminsGroup.pk);
          await updateUser(userId, { groups: currentGroups });
        } else {
          // Add to Admins group
          const currentGroups = [...user.groups, adminsGroup.pk];
          await updateUser(userId, { groups: currentGroups });
        }

        return NextResponse.json({ success: true, is_superuser: !user.is_superuser });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error('[UI Bridge] User action error:', err);
    const message = err instanceof Error ? err.message : 'Action failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) {
    return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
  }

  try {
    await deleteUser(userId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] Delete user error:', err);
    const message = err instanceof Error ? err.message : 'Failed to delete user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
