/**
 * Setup Restore API
 *
 * POST /api/setup/restore — Execute a full platform restore from backup.
 * Streams progress via Server-Sent Events.
 *
 * Only available when setup_completed is false (during initial setup).
 * Calls fullRestore() from the backup restore module and relays events.
 * On completion, marks setup as complete via spineClient.patchConfig.
 */

import { NextRequest } from 'next/server';
import { spineClient } from '@/lib/spine/client';
import { fullRestore } from '@/lib/backup/full-restore';

interface RestoreRequest {
  backupPath: string;
  passphrase: string;
}

export async function POST(request: NextRequest) {
  // Guard: only available during initial setup
  try {
    const config = await spineClient.getConfig();
    if (config.setup_completed === true) {
      return new Response('Setup already completed — restore is only available during initial setup', { status: 403 });
    }
  } catch {
    // Spine not reachable — allow restore to proceed (setup not complete)
  }

  let body: RestoreRequest;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid request body', { status: 400 });
  }

  if (!body.backupPath || typeof body.backupPath !== 'string') {
    return new Response('backupPath is required', { status: 400 });
  }
  if (!body.passphrase || typeof body.passphrase !== 'string') {
    return new Response('passphrase is required', { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        await fullRestore(
          {
            backupPath: body.backupPath,
            passphrase: body.passphrase,
          },
          (event) => {
            send({
              step: event.step,
              totalSteps: event.totalSteps,
              status: event.status,
              stage: event.stage,
              message: event.message,
              detail: event.detail,
              progress: event.progress,
            });
          }
        );

        // Mark setup as complete — the restored config includes setup_completed
        // but we explicitly set it to ensure the wizard redirects to dashboard
        try {
          await spineClient.patchConfig({ setup_completed: true });
        } catch (err) {
          console.warn('[restore] Failed to mark setup as complete via Spine:', err);
        }

        send({ complete: true });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('[restore] Full restore failed:', err);
      }

      controller.close();
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
