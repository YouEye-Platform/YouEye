/**
 * Update Queue Status API
 *
 * GET  /api/apps/queue         — get all active queue entries
 * POST /api/apps/queue         — acknowledge (dismiss) a completed/failed entry
 *
 * Used by the update-progress embed to poll for status changes.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { validateEmbedSession } from '@/lib/embed/session-auth';
import { getQueueStatus, acknowledgeEntry } from '@/lib/updates/queue';

async function checkAuth(): Promise<boolean> {
  const session = await getSession();
  if (session) return true;
  const embedAuth = await validateEmbedSession('admin');
  return embedAuth.authenticated && embedAuth.authorized;
}

export async function GET() {
  if (!await checkAuth()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const entries = await getQueueStatus();
    return NextResponse.json({ entries });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!await checkAuth()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { id } = body;
    if (!id || typeof id !== 'number') {
      return NextResponse.json({ error: 'Missing entry id' }, { status: 400 });
    }
    await acknowledgeEntry(id);
    return NextResponse.json({ cleared: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
