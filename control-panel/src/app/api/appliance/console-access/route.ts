import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { consolePasswordError } from '@/lib/console-access';
import { consoleRouteError } from '@/lib/console-access/route-error';
import { listIdentityUsers } from '@/lib/identity/store';
import { spineClient, type SpineConsoleStatus } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

/** What Settings shows: the current admins' host accounts (never a hash). */
async function view(status: SpineConsoleStatus, identityId: string | undefined) {
  const users = new Map((await listIdentityUsers()).map(user => [user.id, user]));
  return {
    accounts: status.accounts.filter(account => account.admin).map(account => ({
      userId: account.user_id,
      hostUsername: account.username,
      name: users.get(account.user_id)?.name || users.get(account.user_id)?.username || account.username,
      canSignIn: !account.locked,
      you: account.user_id === identityId,
    })),
    rootPasswordSet: status.root_password_set,
    passwordSSH: status.password_ssh,
    sshScope: status.ssh_scope || null,
  };
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await view(await spineClient.consoleStatus(), session.identityId));
  } catch (error) {
    return consoleRouteError(error);
  }
}

/** Advanced: root password (set, or "" to remove) and password SSH from the local subnet. */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { rootPassword?: unknown; passwordSSH?: unknown } | null;
  const settings: { root_password?: string; password_ssh?: boolean } = {};
  if (body && 'rootPassword' in body) {
    if (body.rootPassword !== '') {
      const passwordError = consolePasswordError(body.rootPassword);
      if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
    }
    settings.root_password = body.rootPassword as string;
  }
  if (body && 'passwordSSH' in body) {
    if (typeof body.passwordSSH !== 'boolean') return NextResponse.json({ error: 'passwordSSH must be true or false.' }, { status: 400 });
    settings.password_ssh = body.passwordSSH;
  }
  if (!Object.keys(settings).length) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });
  try {
    return NextResponse.json(await view(await spineClient.updateConsoleSettings(settings), session.identityId));
  } catch (error) {
    return consoleRouteError(error);
  }
}
