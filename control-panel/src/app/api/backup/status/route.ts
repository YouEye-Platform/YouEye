import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await spineClient.getBackupStatus());
  } catch {
    return NextResponse.json({ status: 'idle', message: 'No backup operation is running' });
  }
}
