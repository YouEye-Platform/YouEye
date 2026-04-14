/**
 * Full Platform Restore API — SSE endpoint.
 *
 * POST /api/restore/full
 * Body: { backupPath, passphrase }
 *
 * Triggers a full platform restore and streams progress events via SSE.
 */

import { NextRequest } from 'next/server';
import { fullRestore } from '@/lib/backup/full-restore';
import type { BackupEvent } from '@/lib/backup/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: { backupPath?: string; passphrase?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.backupPath || !body.passphrase) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: backupPath, passphrase' }),
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
        await fullRestore(
          {
            backupPath: body.backupPath!,
            passphrase: body.passphrase!,
          },
          onEvent
        );
      } catch (err) {
        const errorEvent: BackupEvent = {
          step: 0,
          totalSteps: 0,
          status: 'error',
          stage: 'fatal',
          message: 'Full restore failed unexpectedly',
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
