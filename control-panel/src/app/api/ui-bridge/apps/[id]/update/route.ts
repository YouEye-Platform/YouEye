/**
 * UI Bridge: App Update (SSE)
 *
 * POST /api/ui-bridge/apps/:id/update
 *
 * Streams update progress via SSE. Proxies to the existing app update logic.
 */

import { type NextRequest } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateOCIApp, type UpdateEvent } from '@/lib/apps/updater';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { spineClient } from '@/lib/spine/client';

function sseMessage(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateBridgeToken(request);
  if (authError) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { id } = await params;
  const appDef = getAppDefinition(id);
  if (!appDef) {
    return new Response(JSON.stringify({ error: 'App not found' }), { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: UpdateEvent) => {
        try {
          controller.enqueue(encoder.encode(sseMessage(event)));
        } catch {
          // stream closed
        }
      };

      try {
        if (appDef.updatedBy === 'control-panel' && appDef.type === 'lxd') {
          await updateLXDApp(appDef, emit);
        } else if (appDef.updatedBy === 'control-panel') {
          await updateOCIApp(appDef, emit);
        } else {
          emit({ stage: 'starting', message: 'Starting update via Spine', progress: 10 });
          let result;
          switch (id) {
            case 'spine': result = await spineClient.updateSelf(); break;
            case 'control-panel': result = await spineClient.updateControl(); break;
            case 'incus': result = await spineClient.updateIncus(); break;
            case 'host-system': result = await spineClient.updateSystem(); break;
            default: throw new Error(`No update handler for ${id}`);
          }
          if (result.status === 'success' || result.status === 'updated' || result.status === 'no_update') {
            emit({ stage: 'completed', message: result.message || 'Update completed', progress: 100 });
          } else {
            throw new Error(result.message || 'Update failed');
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emit({ stage: 'failed', message: msg, error: msg });
      } finally {
        try { controller.close(); } catch {}
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
