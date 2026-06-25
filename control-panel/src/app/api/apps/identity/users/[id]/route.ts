/**
 * Identity User Detail API
 * GET /api/apps/identity/users/[id] — Get user
 * PATCH /api/apps/identity/users/[id] — Update user
 * DELETE /api/apps/identity/users/[id] — Delete user
 *
 * The URL is kept for compatibility with the current Settings UI. During the
 * It is backed by the provider-neutral identity layer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteUser, getUser, updateUser } from '@/lib/identity/provider';
import { getSession } from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const user = await getUser(id);
    return NextResponse.json(user);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json();
    const user = await updateUser(id, body);
    return NextResponse.json(user);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    await deleteUser(id);
    return NextResponse.json({ status: 'deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
