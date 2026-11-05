/**
 * Identity Set Password API
 * POST /api/apps/identity/users/[id]/password
 *
 * The URL is kept for compatibility with the current Settings UI. During the
 * It is backed by the provider-neutral identity layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { setPassword } from '@/lib/identity/provider';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
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
    const { id } = await params;
    const body = await request.json();
    const { password, repeatPassword } = body;

	if (password !== repeatPassword) return NextResponse.json({ error: 'Passwords do not match' }, { status: 400 });

	const passwordError = validateIdentityPassword(password);
	if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

    await setPassword(id, password);
    return NextResponse.json({ status: 'password_set' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
