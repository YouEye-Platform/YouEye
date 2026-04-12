/**
 * App Market Update API — SSE endpoint.
 * Updates an installed marketplace app to the latest catalog version.
 *
 * POST /api/market/update
 * Body: { appId: string, force?: boolean }
 *
 * Returns Server-Sent Events stream with progress updates.
 */

import { NextRequest } from 'next/server';
import { updateMarketplaceApp } from '@/lib/market/updater';
import type { InstallEvent } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: { appId: string; force?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.appId) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: appId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const onEvent = (event: InstallEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may have been closed by client
        }
      };

      try {
        const result = await updateMarketplaceApp(
          { appId: body.appId, force: body.force },
          onEvent
        );

        // Send final result as a completion event
        const finalEvent = {
          step: 0,
          totalSteps: 0,
          status: result.success ? 'success' as const : 'error' as const,
          message: result.success
            ? `Updated ${body.appId} from v${result.previousVersion} to v${result.newVersion}`
            : `Update failed: ${result.error}`,
          detail: JSON.stringify(result),
        };
        const data = `data: ${JSON.stringify(finalEvent)}\n\n`;
        try { controller.enqueue(encoder.encode(data)); } catch { /* ok */ }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errorEvent = {
          step: 0,
          totalSteps: 0,
          status: 'error' as const,
          message: `Update failed: ${errMsg}`,
        };
        const data = `data: ${JSON.stringify(errorEvent)}\n\n`;
        try { controller.enqueue(encoder.encode(data)); } catch { /* ok */ }
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
    },
  });
}
