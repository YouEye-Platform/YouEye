/**
 * SSE endpoint for infrastructure reconciliation.
 * Deploys only MISSING infrastructure containers — does not touch existing ones.
 * Called by Spine after `spine update control` to ensure infrastructure is intact.
 *
 * POST /api/deploy/infrastructure/reconcile
 * Headers: X-Deploy-Secret: <secret>
 * Body: { "host_ip": "192.168.31.44" }
 * Response: text/event-stream with DeploymentEvent JSON per line
 */

import { NextRequest } from 'next/server';
import { reconcileInfrastructure } from '@/lib/infrastructure/deployer';
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

      // Run reconciliation asynchronously, streaming events
      reconcileInfrastructure(hostIP, sendEvent)
        .then(() => {
          clearInterval(keepalive);
          sendEvent({
            step: 6,
            totalSteps: 6,
            status: 'success',
            message: 'Infrastructure reconciliation complete',
          });
          controller.close();
        })
        .catch((err) => {
          clearInterval(keepalive);
          sendEvent({
            step: 0,
            totalSteps: 6,
            status: 'error',
            message: 'Reconciliation failed with unexpected error',
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
