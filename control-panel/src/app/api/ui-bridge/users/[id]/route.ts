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
  setPassword,
} from '@/lib/identity/provider';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();
    const { action, password } = body;

    switch (action) {
      case 'set-password': {
		const passwordError = validateIdentityPassword(password);
		if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
        await setPassword(id, password);
        return NextResponse.json({ success: true });
      }

      case 'toggle-active': {
        const user = await getUser(id);
        await updateUser(id, { is_active: !user.is_active });
        return NextResponse.json({ success: true, is_active: !user.is_active });
      }

      case 'toggle-admin': {
        const user = await getUser(id);
        const currentGroups = user.groups || [];
        const isAdmin = !user.is_superuser;
        const groups = isAdmin
          ? Array.from(new Set([...currentGroups, 'admin']))
          : currentGroups.filter((g) => g !== 'admin');

        await updateUser(id, { groups, isAdmin });
        return NextResponse.json({ success: true, is_superuser: isAdmin });
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

  try {
    await deleteUser(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] Delete user error:', err);
    const message = err instanceof Error ? err.message : 'Failed to delete user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
