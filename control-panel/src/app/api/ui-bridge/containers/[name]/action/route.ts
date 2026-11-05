/**
 * UI Bridge: Container Actions
 *
 * POST /api/ui-bridge/containers/[name]/action
 *
 * Start, stop, or restart a specific container.
 * Reuses existing Incus state change logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { incusRequest, updateInstanceState } from '@/lib/incus/server';
import { AppLifecycleAdmissionError, withContainerLifecycle } from '@/lib/market/update-admission';

const VALID_ACTIONS = ['start', 'stop', 'restart'] as const;
type ContainerAction = (typeof VALID_ACTIONS)[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const { name } = await params;

    if (!name || name.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Container name is required' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const action = body.action as string;

    if (!action || !VALID_ACTIONS.includes(action as ContainerAction)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const response = await withContainerLifecycle(name, async () => {
      const result = await updateInstanceState(name, action as ContainerAction, false);
      if (result.type === 'async' && result.operation) {
        const waited = await incusRequest('GET', `${result.operation}/wait?timeout=90`, undefined, { timeout: 100_000 });
        if (waited.type === 'error'
          || (waited.metadata as { status?: string } | undefined)?.status === 'Failure') {
          throw new Error('Container state change failed');
        }
      }
      return result;
    });

    if (response.type === 'error') {
      return NextResponse.json(
        {
          success: false,
          error: response.error || `Failed to ${action} container`,
        },
        { status: 500 }
      );
    }

    console.log(`[UI Bridge] Container ${name} ${action}ed`);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AppLifecycleAdmissionError) {
      return NextResponse.json({ success: false, error: err.message, code: err.code }, { status: 409 });
    }
    console.error('[UI Bridge] Container action error:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to perform container action',
      },
      { status: 500 }
    );
  }
}
