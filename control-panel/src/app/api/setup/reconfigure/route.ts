/**
 * Reconfigure API
 *
 * POST /api/setup/reconfigure — Change the server URL (domain), site name,
 * and/or subdomains on a running platform. Streams progress via Server-Sent
 * Events. Accepts admin browser sessions and the Spine CLI token
 * (`youeye domain set` drives this endpoint).
 */

import { NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { reconfigure } from '@/lib/reconfigure';
import type { ReconfigureRequest, ReconfigureTlsTarget } from '@/lib/reconfigure';

const WIRE_TLS_TARGETS: ReconfigureTlsTarget[] = ['auto', 'selfsigned', 'provider'];

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }

  const raw = await request.json();

  // Allowlist wire fields — bundle-based TLS targets are programmatic-only and
  // reachable exclusively through the dedicated apply endpoints, which install
  // the bundle credentials before reconfiguring.
  const body: ReconfigureRequest = {
    site_name: typeof raw.site_name === 'string' ? raw.site_name : undefined,
    domain: typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : undefined,
    subdomains: raw.subdomains && typeof raw.subdomains === 'object' ? raw.subdomains : undefined,
    site_name_style: raw.site_name_style && typeof raw.site_name_style === 'object' ? raw.site_name_style : undefined,
    identity_name: typeof raw.identity_name === 'string' ? raw.identity_name : undefined,
    tls: WIRE_TLS_TARGETS.includes(raw.tls) ? raw.tls : undefined,
  };

  // Validate at least one field is being changed
  if (!body.site_name && !body.domain && !body.subdomains && !body.site_name_style && !body.identity_name) {
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
