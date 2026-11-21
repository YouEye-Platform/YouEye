/**
 * App Update SSE Endpoint
 *
 * POST /api/apps/[name]/update
 *
 * Streams real-time update progress via Server-Sent Events.
 * - Managed Pointer → apps/lxd-updater (its release on the box's channel)
 * - System containers (Caddy, Pi-Hole, Postgres) → apps/system-container-update (rebuild on the image this release
 *   pins, with the body's acknowledgements: confirmMaintenanceWindow, confirmContainerName, allowDatabaseUpdate)
 * - Market-installed/native apps → market/updater (unified: OCI rebuild or LXD tarball + migrations)
 * - Spine, the Control Panel, the UI and the host (Incus, packages) update with the System release (Settings → System)
 */

import { type NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateLXDApp, type UpdateEvent } from '@/lib/apps/lxd-updater';
import { updateSystemContainerApp } from '@/lib/apps/system-container-update';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { handleMarketUpdate } from '@/lib/market/update-http';

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { name } = await params;
  const appDef = getAppDefinition(name);
  if (!appDef) return handleMarketUpdate(req, name);

  if (!session.isAdmin) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }
  if (!await verifyCSRFToken(req.headers.get('X-CSRF-Token') || '')) {
    return Response.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  // A system container's acknowledgements; the body is read before the stream starts.
  const body: Record<string, unknown> = appDef.systemImageId
    ? await req.json().then((value) => (value && typeof value === 'object' ? value : {}), () => ({}))
    : {};

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: UpdateEvent) => {
        try {
          controller.enqueue(encoder.encode(sseMessage('update', event)));
        } catch {
          // stream may have been closed by the client
        }
      };

      try {
        if (appDef.updatedBy === 'control-panel' && appDef.type === 'lxd') {
          await withUserOperationLockWait(() => updateLXDApp(appDef, emit));
        } else if (appDef.updatedBy === 'control-panel' && appDef.systemImageId) {
          // A caller with no way to acknowledge (the `youeye` CLI) is told where the update is, before any work.
          if (body.confirmMaintenanceWindow !== true) {
            throw new Error(`${appDef.displayName} is a system container: its update stops and rebuilds it, which has to be acknowledged. Update it in Settings → Apps.`);
          }
          emit({ stage: 'starting', message: `Starting update for ${appDef.displayName}`, progress: 0 });
          const result = await updateSystemContainerApp(appDef, body, (event) => {
            if (event.status !== 'running') return;
            const progress = event.totalSteps > 0 ? Math.min(Math.round((event.step / event.totalSteps) * 100), 99) : 0;
            emit({ stage: 'rebuilding', message: event.message, progress });
          });
          if (!result.success) throw new Error(result.error || result.message);
          emit({ stage: 'completed', message: result.message, progress: 100 });
        } else {
          throw new Error(`${appDef.displayName} updates with the System release (Settings → System)`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emit({ stage: 'failed', message: msg, error: msg });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
