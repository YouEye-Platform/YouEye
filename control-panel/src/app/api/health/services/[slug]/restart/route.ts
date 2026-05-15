/**
 * Service Restart API
 *
 * POST /api/health/services/{slug}/restart — restarts the named container.
 * Not allowed for Spine (self-manages).
 * Requires admin session + CSRF.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { updateInstanceState, getInstanceState } from '@/lib/incus/server';

const SLUG_TO_CONTAINER: Record<string, string> = {
  authentik: 'youeye-authentik',
  pihole: 'youeye-pihole',
  caddy: 'youeye-caddy',
  postgres: 'youeye-postgres',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const { slug } = await params;
  const container = SLUG_TO_CONTAINER[slug];
  if (!container) {
    return NextResponse.json(
      { error: slug === 'spine' ? 'Spine self-manages — cannot restart via UI' : 'Unknown service' },
      { status: 400 }
    );
  }

  try {
    // Check current state
    const stateRes = await getInstanceState(container);
    const state = stateRes.metadata as { status: string } | undefined;
    const isStopped = state?.status !== 'Running';

    if (isStopped) {
      // Start it
      await updateInstanceState(container, 'start');
    } else {
      // Restart
      await updateInstanceState(container, 'restart');
    }

    // Wait for it to come back
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify it's running
    const afterRes = await getInstanceState(container);
    const afterState = afterRes.metadata as { status: string } | undefined;

    return NextResponse.json({
      success: true,
      status: afterState?.status === 'Running' ? 'running' : 'starting',
      message: `${slug} ${isStopped ? 'started' : 'restarted'} successfully`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Restart failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
