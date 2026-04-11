/**
 * SSE endpoint for infrastructure deployment.
 * Called by Spine during `spine deploy` after the CP container is up.
 * 
 * POST /api/deploy/infrastructure
 * Headers: X-Deploy-Secret: <secret>
 * Body: { "host_ip": "192.168.31.190" }
 * Response: text/event-stream with DeploymentEvent JSON per line
 */

import { NextRequest } from 'next/server';
import { deployInfrastructure } from '@/lib/infrastructure/deployer';
import type { DeploymentEvent } from '@/lib/infrastructure/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Validate deploy secret
  const secret = request.headers.get('X-Deploy-Secret');
  const expectedSecret = process.env.TEST_ADMIN_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse request body
  let hostIP: string;
  try {
    const body = await request.json();
    hostIP = body.host_ip;
    if (!hostIP) throw new Error('missing host_ip');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid body — expected { "host_ip": "..." }' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Create SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (event: DeploymentEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may have been closed by client
        }
      };

      // Keepalive: send SSE comment every 10s to prevent idle timeouts
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 10_000);

      // Run deployment asynchronously, streaming events
      deployInfrastructure(hostIP, sendEvent)
        .then(() => {
          clearInterval(keepalive);
          // Send final completion event
          sendEvent({
            step: 8,
            totalSteps: 8,
            status: 'success',
            message: 'Infrastructure deployment complete',
          });
          controller.close();
        })
        .catch((err) => {
          clearInterval(keepalive);
          sendEvent({
            step: 0,
            totalSteps: 8,
            status: 'error',
            message: 'Deployment failed with unexpected error',
            detail: String(err),
          });
          controller.close();
        });
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
