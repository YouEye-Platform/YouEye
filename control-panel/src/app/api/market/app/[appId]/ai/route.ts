import { NextRequest, NextResponse } from 'next/server';
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
        ...(await getManagedAIStatus(appId, auth.actor)),
        currentActorId: auth.actor.id,
      });
    } catch (error) {
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
    const connection = parsed.data.action === 'enable'
      ? await enableManagedAI(appId, auth.actor, parsed.data.groupId)
      : parsed.data.action === 'disable'
        ? await disableManagedAI(appId, auth.actor)
        : parsed.data.action === 'change_group'
          ? await changeManagedAIGroup(appId, auth.actor, parsed.data.groupId)
          : await takeOverManagedAI(appId, auth.actor, parsed.data.groupId);
    return NextResponse.json({ connection });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI Settings update failed' },
      { status: 409 },
    );
  }
}
