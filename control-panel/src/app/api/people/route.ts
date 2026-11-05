/**
 * People API
 *
 * GET  /api/people - List identity users
 * POST /api/people - Create a new user
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { createUser, listUsers } from '@/lib/identity/provider';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const search = request.nextUrl.searchParams.get('search') || undefined;

    const data = await listUsers({ search, page_size: 200 });

    const users = data.results.map(u => ({
      pk: u.pk,
      username: u.username,
      name: u.name,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      isActive: u.is_active,
      isAdmin: u.is_superuser,
      type: u.type,
      lastLogin: u.last_login || null,
    }));

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
    const { username, firstName, lastName, email, password, repeatPassword, isAdmin: makeAdmin } = body as {
      username: string;
      firstName: string;
      lastName?: string;
      email: string;
      password?: string;
      repeatPassword?: string;
      isAdmin?: boolean;
    };

    if (!username || !firstName || !email || !password || !repeatPassword) {
      return NextResponse.json({ error: 'First name, username, email, password, and repeat password are required' }, { status: 400 });
    }
	if (password !== repeatPassword) return NextResponse.json({ error: 'Passwords do not match' }, { status: 400 });
	if (password !== undefined) {
	  const passwordError = validateIdentityPassword(password);
	  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
	}

    const user = await createUser({ username, firstName, lastName, email, password, isAdmin: makeAdmin });

    return NextResponse.json({ user, success: true });
  } catch (error) {
    console.error('Error creating user:', error);
    return NextResponse.json(
      { error: 'Failed to create user', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
