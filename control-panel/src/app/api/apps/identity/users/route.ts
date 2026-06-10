/**
 * Identity Users API
 * GET /api/apps/identity/users — List users
 * POST /api/apps/identity/users — Create user
 *
 * The URL is kept for compatibility with the current Settings UI. During the
 * It is backed by the provider-neutral identity layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createUser, listUsers } from '@/lib/identity/provider';
import { getSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || undefined;
    const page = searchParams.get('page') ? Number(searchParams.get('page')) : undefined;

    const result = await listUsers({ search, page });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { username, name, email, password, is_active, groups, isAdmin } = body;

    if (!username || !name) {
      return NextResponse.json(
        { error: 'username and name are required' },
        { status: 400 }
      );
    }

    const user = await createUser({ username, name, email, password, is_active, groups, isAdmin });
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
