/**
 * Internet Grant by ID
 *
 * DELETE /api/internet-grants/:id — revoke a grant
 */

import { NextResponse } from 'next/server';
import { deleteInternetGrant } from '@/lib/bridges/internet-store';
import { setAppNetworkNAT } from '@/lib/incus/app-network';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const grant = await deleteInternetGrant(id);

  if (!grant) {
    return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
  }

  // Disable NAT on the app's per-app bridge
  await setAppNetworkNAT(grant.appId, false);

  return NextResponse.json({ ok: true });
}
