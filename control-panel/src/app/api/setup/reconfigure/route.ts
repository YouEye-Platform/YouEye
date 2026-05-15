/**
 * Reconfigure API
 *
 * POST /api/setup/reconfigure — Change domain, site name, and/or subdomains.
 * Streams progress via Server-Sent Events.
 */

import { NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { reconfigure } from '@/lib/reconfigure';
import type { ReconfigureRequest } from '@/lib/reconfigure';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }

  const body: ReconfigureRequest = await request.json();

  // Validate at least one field is being changed
  if (!body.site_name && !body.domain && !body.subdomains && !body.site_name_style && !body.authentik_name) {
    return new Response(JSON.stringify({ error: 'At least one field must be provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate domain format if provided
  if (body.domain) {
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
    if (!domainRegex.test(body.domain)) {
      return new Response(JSON.stringify({ error: 'Invalid domain format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const result = await reconfigure(body, (event) => {
          send(event);
        });

        send({ complete: true, newUrl: result.newUrl });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('Reconfigure failed:', err);
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
