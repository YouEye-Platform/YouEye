import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import {
  getSystemUpdateSelection,
  saveSystemUpdateSelection,
} from '@/lib/appliance/system-update-source';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json(await getSystemUpdateSelection());
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  try {
    return NextResponse.json(await saveSystemUpdateSelection(await request.json()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'System update source is invalid.' }, { status: 400 });
  }
}
