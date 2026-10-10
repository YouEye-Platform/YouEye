/**
 * App Update SSE Endpoint
 *
 * POST /api/apps/[name]/update
 *
 * Streams real-time update progress via Server-Sent Events.
 * - Infrastructure LXD apps (UI) → apps/lxd-updater (tarball download + service restart)
 * - Infrastructure OCI apps (Caddy, Pi-Hole, Postgres) → apps/updater (Incus rebuild)
 * - Market-installed/native apps → market/updater (unified: OCI rebuild or LXD tarball + migrations)
 * - System components (Spine, Incus, host) → Spine API proxy
 */

import { type NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateOCIApp, type UpdateEvent } from '@/lib/apps/updater';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { resolveLxdAppChannel } from '@/lib/apps/lxd-updates';
import { handleMarketUpdate } from '@/lib/market/update-http';
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
  if (!appDef) return handleMarketUpdate(req, name);

  if (!session.isAdmin) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }
  if (!await verifyCSRFToken(req.headers.get('X-CSRF-Token') || '')) {
    return Response.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  let confirmSwitch = false;
  try {
    const body = await req.json();
    confirmSwitch = body?.confirm_switch === true;
  } catch {
    confirmSwitch = false;
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
          // Infrastructure LXD apps (UI) or native apps in static definitions
          const resolved = await resolveLxdAppChannel(appDef);
          if (resolved) {
            if (!resolved.candidate) {
              throw new Error(`Channel for ${appDef.id} has no resolvable release`);
            }
            const switching = !!resolved.installed?.tag && resolved.installed.tag !== resolved.candidate.tag;
            if (switching && !confirmSwitch) {
              throw new Error(`Channel switch for ${appDef.id} requires confirmation`);
            }
            await updateLXDApp(appDef, emit, {
              version: resolved.candidate.version,
              tag: resolved.candidate.tag,
              branch: resolved.candidate.branch,
              source: resolved.channel.source,
              artifactSHA256: resolved.candidate.artifactSHA256,
            });
          } else {
            await updateLXDApp(appDef, emit);
          }
        } else if (appDef.updatedBy === 'control-panel') {
          // Infrastructure OCI apps
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
    emit({ stage: 'completed', message: result.message || 'Update completed', progress: 100 });
  } else {
    throw new Error(result.message || 'Update failed');
  }
}
