/**
 * Internet Grant by ID
 *
 * DELETE /api/internet-grants/:id — revoke a grant
 */

import { NextResponse } from 'next/server';
import { deleteInternetGrant } from '@/lib/bridges/internet-store';
import { revokeInternetAccess } from '@/lib/incus/network-acl';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const grant = await deleteInternetGrant(id);

  if (!grant) {
    return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
  }

  // Revoke the Incus ACL
  await revokeInternetAccess(grant.containerName, grant.aclName);

  return NextResponse.json({ ok: true });
}
