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
import { getSession } from '@/lib/auth/session';
import { verifyCSRFToken } from '@/lib/auth';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
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
  if (!session.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
	const csrf = request.headers.get('X-CSRF-Token');
	if (!csrf || !(await verifyCSRFToken(csrf))) {
	  return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
	}

  try {
    const body = await request.json();
    const { username, firstName, lastName, email, password, repeatPassword, is_active, groups, isAdmin } = body;

    if (!username || !firstName || !email || !password || !repeatPassword) {
      return NextResponse.json(
        { error: 'First name, username, email, password, and repeat password are required' },
        { status: 400 }
      );
    }
	if (!/^[a-z][a-z0-9._-]{2,31}$/.test(String(username).trim())) return NextResponse.json({ error: 'Username must be 3-32 characters and start with a lowercase letter.' }, { status: 400 });
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
	if (password !== repeatPassword) return NextResponse.json({ error: 'Passwords do not match' }, { status: 400 });
	if (password !== undefined) {
	  const passwordError = validateIdentityPassword(password);
	  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
	}

    const user = await createUser({ username: String(username).trim(), firstName: String(firstName).trim(), lastName: typeof lastName === 'string' ? lastName.trim() : '', email: String(email).trim(), password, is_active, groups, isAdmin });
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
