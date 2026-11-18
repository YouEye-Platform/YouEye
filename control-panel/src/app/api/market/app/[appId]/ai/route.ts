import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { lifecycleBusyResponse } from '@/lib/http/lifecycle-busy';
import { NextRequest, NextResponse } from 'next/server';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getUserByUsername } from '@/lib/identity/store';
import {
  changeManagedAIGroup,
  disableManagedAI,
  enableManagedAI,
  getManagedAIStatus,
  installedAppSupportsManagedAI,
  takeOverManagedAI,
} from '@/lib/market/managed-ai';

export const dynamic = 'force-dynamic';

const MutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), groupId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('disable') }).strict(),
  z.object({ action: z.literal('change_group'), groupId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('takeover'), groupId: z.string().min(1).max(200) }).strict(),
]);

async function actorForRequest() {
  const auth = await requireAdmin();
  if (auth.error) return { error: auth.error } as const;
  const user = await getUserByUsername(auth.session.username);
  if (!user) {
    return {
      error: NextResponse.json(
        { error: 'AI Settings require a YouEye user account' },
        { status: 400 },
      ),
    } as const;
  }
  return {
    actor: {
      id: user.id,
      name: user.name || user.username,
      isAdmin: user.is_admin,
    },
  } as const;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const auth = await actorForRequest();
  if ('error' in auth) return auth.error;
  const { appId } = await params;
  try {
    const supported = await installedAppSupportsManagedAI(appId);
    if (!supported) {
      return NextResponse.json({ supported: false, currentActorId: auth.actor.id });
    }
    try {
      return NextResponse.json({
        ...(await withUserOperationLockWait(() => getManagedAIStatus(appId, auth.actor))),
        currentActorId: auth.actor.id,
      });
    } catch (error) {
      const busy = lifecycleBusyResponse(error);
      if (busy) return busy;
      logOperationFailure(`Reading AI Settings of ${appId}`, error);
      return NextResponse.json(
        {
          supported: true,
          currentActorId: auth.actor.id,
          error: error instanceof Error ? error.message : 'AI Settings status is unavailable',
        },
        { status: 503 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI Settings status is unavailable';
    return NextResponse.json({ error: message }, { status: message.startsWith('Unknown installed app') ? 404 : 400 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const auth = await actorForRequest();
  if ('error' in auth) return auth.error;
  const csrf = request.headers.get('X-CSRF-Token');
  if (!csrf || !(await verifyCSRFToken(csrf))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const parsed = MutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid AI Settings action' }, { status: 400 });
  }
  const { appId } = await params;
  try {
    const action = parsed.data;
    const connection = await withUserOperationLockWait(() => action.action === 'enable'
      ? enableManagedAI(appId, auth.actor, action.groupId)
      : action.action === 'disable'
        ? disableManagedAI(appId, auth.actor)
        : action.action === 'change_group'
          ? changeManagedAIGroup(appId, auth.actor, action.groupId)
          : takeOverManagedAI(appId, auth.actor, action.groupId));
    return NextResponse.json({ connection });
  } catch (error) {
    const busy = lifecycleBusyResponse(error);
    if (busy) return busy;
    logOperationFailure(`AI Settings ${parsed.data.action} for ${appId}`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI Settings update failed' },
      { status: 409 },
    );
  }
}
