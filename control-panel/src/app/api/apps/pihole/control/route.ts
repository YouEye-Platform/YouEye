/**
 * Pi-Hole Control API
 *
 * Enable/disable Pi-Hole blocking and container management
 * Updated for Pi-Hole FTL v6+ API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { PIHOLE_MANIFEST } from '@/lib/apps/manifest';
import { setBlocking } from '@/lib/apps/pihole-api';
import { incusRequest } from '@/lib/incus/server';

const CONTAINER_NAME = PIHOLE_MANIFEST.containerName;

/**
 * Manage container state (start/stop/restart)
 */
async function containerAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
  const stateAction = action === 'restart' ? 'restart' : action;

  const response = await incusRequest('PUT', `/1.0/instances/${CONTAINER_NAME}/state`, {
    action: stateAction,
    timeout: 30,
    force: false,
  });

  if (response.type === 'error') {
    throw new Error(response.error || `Failed to ${action} container`);
  }
}

/**
 * POST - Control Pi-Hole blocking or container state
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { action, duration } = await request.json();

    // Container management actions
    if (['start', 'stop', 'restart'].includes(action)) {
      await containerAction(action as 'start' | 'stop' | 'restart');
      console.log(`[Pi-Hole] Container ${action}ed by ${session.username}`);
      return NextResponse.json({
        success: true,
        message: `Pi-Hole container ${action}ed`,
      });
    }

    // Blocking control actions
    if (!['enable', 'disable'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const enabled = action === 'enable';
    // Duration in seconds (only for disable)
    const timer = !enabled && duration ? parseInt(duration) : undefined;

    await setBlocking(enabled, timer);

    console.log(`[Pi-Hole] ${action}d by ${session.username}${duration ? ` for ${duration}s` : ''}`);
    return NextResponse.json({
      success: true,
      message: `Pi-Hole ${action}d`,
    });
  } catch (error) {
    console.error('Error controlling Pi-Hole:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to control Pi-Hole' },
      { status: 500 }
    );
  }
}
