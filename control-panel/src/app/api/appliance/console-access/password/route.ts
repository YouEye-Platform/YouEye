import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { consolePasswordError, syncConsoleAdmins } from '@/lib/console-access';
import { spineClient } from '@/lib/spine/client';
import { consoleRouteError } from '@/lib/console-access/route-error';

export const dynamic = 'force-dynamic';

/**
 * The signed-in admin's own console password, separate from their YouEye ID
 * password (for an admin who signs in with a passkey). Sent once; Spine keeps
 * only a hash.
 */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  if (!session.identityId) {
    return NextResponse.json({ error: 'Sign in with YouEye ID to set your console password.' }, { status: 400 });
  }
  const body = await request.json().catch(() => null) as { password?: unknown; repeatPassword?: unknown } | null;
  const passwordError = consolePasswordError(body?.password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  if (body?.password !== body?.repeatPassword) return NextResponse.json({ error: 'Passwords do not match.' }, { status: 400 });
  // The account exists once the admin set is synced (a missed sync is repaired here).
  await syncConsoleAdmins();
  try {
    await spineClient.setConsolePassword(session.identityId, body!.password as string);
    return NextResponse.json({ success: true });
  } catch (error) {
    return consoleRouteError(error);
  }
}
