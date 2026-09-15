import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { planSystemUpdates, updateSystemFromMarket } from '@/lib/infrastructure/system-updater';
import { assertNoCriticalIssues } from '@/lib/health/issues';
import type { DeploymentEvent } from '@/lib/infrastructure/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  try {
    const systems = await planSystemUpdates();
    return NextResponse.json({
      systems,
      source: 'market-system-manifests',
      managedBy: 'control-panel',
    });
  } catch (error) {
    console.error('[infrastructure/system-updates] plan failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to plan system updates' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  let body: {
    systemId?: 'postgresql' | 'caddy' | 'pihole';
    hostIP?: string;
    forceLegacy?: boolean;
    allowDatabaseUpdate?: boolean;
    confirmMaintenanceWindow?: boolean;
    confirmContainerName?: string;
    dryRun?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.systemId) {
    return NextResponse.json({ error: 'Missing required field: systemId' }, { status: 400 });
  }

  const hostIP = body.hostIP || process.env.HOST_IP || '';

  if (!body.dryRun && body.systemId === 'pihole' && !hostIP) {
    return NextResponse.json(
      { error: 'hostIP is required for Pi-hole updates because its DNS proxy binds to the host IP' },
      { status: 400 },
    );
  }

  if (!body.dryRun) {
    try {
      await assertNoCriticalIssues('Pool/system operation');
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 423 },
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: DeploymentEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Client may have closed the SSE stream.
        }
      };

      try {
        const result = await updateSystemFromMarket(
          {
            systemId: body.systemId!,
            hostIP,
            forceLegacy: body.forceLegacy,
            allowDatabaseUpdate: body.allowDatabaseUpdate,
            confirmMaintenanceWindow: body.confirmMaintenanceWindow,
            confirmContainerName: body.confirmContainerName,
            dryRun: body.dryRun,
          },
          sendEvent,
        );

        sendEvent({
          step: 0,
          totalSteps: 0,
          status: result.success ? 'success' : 'error',
          message: result.message,
          detail: JSON.stringify(result),
        });
      } catch (error) {
        sendEvent({
          step: 0,
          totalSteps: 0,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
