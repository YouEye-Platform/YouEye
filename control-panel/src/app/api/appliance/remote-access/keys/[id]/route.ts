import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { SpineAPIError, spineClient } from '@/lib/spine/client';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const { id } = await params;
  if (!/^[0-9a-f]{24}$/.test(id)) {
    return NextResponse.json({ error: 'A valid key ID is required.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await spineClient.deleteRemoteAccessKey(id, body.confirm_last_key === true));
  } catch (error) {
    if (error instanceof SpineAPIError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    console.error('[remote-access] Spine deletion failed:', error);
    return NextResponse.json({ error: 'The SSH key could not be deleted.' }, { status: 503 });
  }
}
