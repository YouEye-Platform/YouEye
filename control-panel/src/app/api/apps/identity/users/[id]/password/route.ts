/**
 * Identity Set Password API
 * POST /api/apps/identity/users/[id]/password
 *
 * The URL is kept for compatibility with the current Settings UI. During the
 * It is backed by the provider-neutral identity layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { setPassword } from '@/lib/identity/provider';
import { getSession } from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json();
    const { password } = body;

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    await setPassword(id, password);
    return NextResponse.json({ status: 'password_set' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
