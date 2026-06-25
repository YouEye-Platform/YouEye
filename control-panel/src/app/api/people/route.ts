/**
 * People API
 *
 * GET  /api/people - List identity users
 * POST /api/people - Create a new user
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { createUser, listUsers } from '@/lib/identity/provider';

/** Usernames / types hidden by default */
const HIDDEN_USERNAMES = ['akadmin'];
const HIDDEN_TYPES = ['service_account', 'internal_service_account'];

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const showHidden = request.nextUrl.searchParams.get('showHidden') === 'true';
    const search = request.nextUrl.searchParams.get('search') || undefined;

    const data = await listUsers({ search, page_size: 200 });

    let users = data.results.map(u => ({
      pk: u.pk,
      username: u.username,
      name: u.name,
      email: u.email,
      isActive: u.is_active,
      isAdmin: u.is_superuser,
      type: u.type,
      lastLogin: u.last_login || null,
      hidden: HIDDEN_USERNAMES.includes(u.username) || HIDDEN_TYPES.includes(u.type),
    }));

    if (!showHidden) {
      users = users.filter(u => !u.hidden);
    }

    return NextResponse.json({ users, adminGroupPk: 'admin' });
  } catch (error) {
    console.error('Error listing users:', error);
    return NextResponse.json(
      { error: 'Failed to list users', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrf = request.headers.get('X-CSRF-Token');
    if (!csrf || !(await verifyCSRFToken(csrf))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const body = await request.json();
    const { username, name, email, password, isAdmin: makeAdmin } = body as {
      username: string;
      name: string;
      email?: string;
      password?: string;
      isAdmin?: boolean;
    };

    if (!username || !name) {
      return NextResponse.json({ error: 'Username and name are required' }, { status: 400 });
    }

    const user = await createUser({ username, name, email, password, isAdmin: makeAdmin });

    return NextResponse.json({ user, success: true });
  } catch (error) {
    console.error('Error creating user:', error);
    return NextResponse.json(
      { error: 'Failed to create user', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
