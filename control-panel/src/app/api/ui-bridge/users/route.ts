/**
 * UI Bridge: Users
 *
 * GET  /api/ui-bridge/users         — list all users
 * POST /api/ui-bridge/users         — create a new user
 *
 * Reuses the provider-neutral identity layer. The route path is stable for
 * the UI bridge; the backend provider is exposed through the identity layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { createUser, listUsers } from '@/lib/identity/provider';

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

    const user = await createUser({ username, name, email: email || '', password });

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
