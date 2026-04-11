/**
 * Backup Run API — SSE endpoint.
 *
 * POST /api/backup/run
 * Body: { targetPath, passphrase }
 *
 * Triggers a full backup and streams progress events via SSE.
 * CP orchestrates the sequence: dump databases, collect configs,
 * then call Spine for host-level operations.
 */

import { NextRequest } from 'next/server';
import { runBackup } from '@/lib/backup/service';
import type { BackupEvent } from '@/lib/backup/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: { targetPath?: string; passphrase?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.targetPath || !body.passphrase) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: targetPath, passphrase' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (body.passphrase.length < 8) {
    return new Response(
      JSON.stringify({ error: 'Passphrase must be at least 8 characters' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const onEvent = (event: BackupEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may have been closed by client
        }
      };

      try {
        await runBackup(
          {
            targetPath: body.targetPath!,
            passphrase: body.passphrase!,
            hostname: '',
          },
          onEvent
        );
      } catch (err) {
        const errorEvent: BackupEvent = {
          step: 0,
          totalSteps: 0,
          status: 'error',
          stage: 'fatal',
          message: 'Backup failed unexpectedly',
          detail: String(err),
        };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        } catch {
          // Stream closed
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
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
