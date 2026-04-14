/**
 * Per-app Backup API — SSE endpoint.
 *
 * POST /api/backup/app/[appId]
 * Body: { targetPath, passphrase }
 *
 * Triggers a per-app backup and streams progress events via SSE.
 */

import { NextRequest } from 'next/server';
import { backupApp } from '@/lib/backup/app-backup';
import type { BackupEvent } from '@/lib/backup/types';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;

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
        await backupApp(
          {
            appId,
            targetPath: body.targetPath!,
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
          message: `App backup failed unexpectedly`,
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
