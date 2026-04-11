/**
 * App Update SSE Endpoint
 *
 * POST /api/apps/[name]/update
 *
 * Streams real-time update progress via Server-Sent Events.
 * - OCI apps (updatedBy=control-panel) → Incus rebuild with rollback
 * - System components (updatedBy=spine) → Spine API proxy
 */

import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateOCIApp, type UpdateEvent } from '@/lib/apps/updater';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { spineClient } from '@/lib/spine/client';

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
  if (!appDef) {
    return new Response(JSON.stringify({ error: 'App not found' }), { status: 404 });
  }

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
          // LXD apps: update via tarball download + service restart
          await updateLXDApp(appDef, emit);
        } else if (appDef.updatedBy === 'control-panel') {
          // OCI apps: update directly via Incus API
          await updateOCIApp(appDef, emit);
        } else {
          // Spine-managed: proxy to Spine API
          await handleSpineUpdate(name, emit);
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

async function handleSpineUpdate(
  appId: string,
  emit: (event: UpdateEvent) => void
): Promise<void> {
  emit({ stage: 'starting', message: 'Starting update via Spine', progress: 10 });

  try {
    let result;
    switch (appId) {
      case 'spine':
        result = await spineClient.updateSelf();
        break;
      case 'control-panel':
        result = await spineClient.updateControl();
        break;
      case 'incus':
        result = await spineClient.updateIncus();
        break;
      case 'host-system':
        result = await spineClient.updateSystem();
        break;
      default:
        throw new Error(`No Spine update handler for ${appId}`);
    }

    if (result.status === 'success' || result.status === 'updated' || result.status === 'no_update') {
      emit({
        stage: 'completed',
        message: result.message || 'Update completed',
        progress: 100,
      });
    } else {
      throw new Error(result.message || 'Update failed');
    }
  } catch (error) {
    throw error;
  }
}
