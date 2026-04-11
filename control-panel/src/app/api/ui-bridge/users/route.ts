/**
 * UI Bridge: Users
 *
 * GET  /api/ui-bridge/users         — list all users
 * POST /api/ui-bridge/users         — create a new user
 *
 * Reuses the existing Authentik client library.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { listUsers, createUser, setUserPassword, listGroups } from '@/lib/authentik/client';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const result = await listUsers({ page_size: 100 });

    const users = result.results.map((user) => ({
      id: user.pk,
      username: user.username,
      name: user.name,
      email: user.email,
      is_active: user.is_active,
      is_superuser: user.is_superuser,
      last_login: user.last_login || null,
      type: user.type,
      path: user.path,
    }));

    return NextResponse.json({ users });
  } catch (err) {
    console.error('[UI Bridge] Users list error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve users' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { username, name, email, password } = body;

    if (!username || !name || !password) {
      return NextResponse.json(
        { error: 'username, name, and password are required' },
        { status: 400 }
      );
    }

    // Create user in Authentik
    const user = await createUser({ username, name, email: email || '' });

    // Set password
    await setUserPassword(user.pk, password);

    return NextResponse.json({
      id: user.pk,
      username: user.username,
      name: user.name,
      email: user.email,
      is_active: user.is_active,
      is_superuser: user.is_superuser,
    });
  } catch (err) {
    console.error('[UI Bridge] Create user error:', err);
    const message = err instanceof Error ? err.message : 'Failed to create user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
