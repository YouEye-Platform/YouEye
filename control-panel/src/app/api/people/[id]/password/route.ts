/**
 * User Password API
 *
 * POST /api/people/[id]/password - Set user password
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { setPassword } from '@/lib/identity/provider';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

export async function POST(
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
    const body = await request.json();
    const { password, repeatPassword } = body as { password: string; repeatPassword: string };

	if (password !== repeatPassword) return NextResponse.json({ error: 'Passwords do not match' }, { status: 400 });

	const passwordError = validateIdentityPassword(password);
	if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

    await setPassword(id, password);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error setting password:', error);
    return NextResponse.json(
      { error: 'Failed to set password', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
