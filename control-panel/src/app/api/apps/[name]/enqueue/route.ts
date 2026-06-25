/**
 * Enqueue Update API
 *
 * POST /api/apps/[name]/enqueue
 *
 * Adds an update to the background queue. Returns immediately with queue entry.
 * The background worker processes updates one at a time.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { validateEmbedSession } from '@/lib/embed/session-auth';
import { enqueueUpdate, getQueuePosition } from '@/lib/updates/queue';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  // Accept either session auth or embed session auth
  const session = await getSession();
  let username = session?.username;

  if (!username) {
    const embedAuth = await validateEmbedSession('admin');
    if (!embedAuth.authenticated || !embedAuth.authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    username = embedAuth.session?.username || 'admin';
  }

  const { name } = await params;

  try {
    const { entry, alreadyQueued } = await enqueueUpdate(name, username);
    const position = await getQueuePosition(name);

    return NextResponse.json({
      queued: true,
      alreadyQueued,
      entry,
      position,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
