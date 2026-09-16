/**
 * BYO Domain — post-setup apply
 *
 * POST /api/tls/domain/apply — switch a RUNNING platform to a saved BYO domain
 * bundle: restores the DNS provider connection (when the bundle carries the
 * token), then runs the full server-URL reconfigure to the bundle's domain,
 * reusing the bundled certificate when it is still valid (re-issuing via the
 * provider otherwise). Streams reconfigure progress via Server-Sent Events.
 *
 * Body: the BYO domain bundle JSON itself (as produced by
 * `youeye domain export [--include-token]`), or `{ "bundle": { ... } }`.
 *
 * Used by `youeye domain import <bundle>` when setup is already completed, and
 * by the Settings → Network → Domain "import a saved domain" flow.
 */

import { NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { reconfigure } from '@/lib/reconfigure';
import {
  isByoDomainBundle,
  byoDomainBundleCertStillValid,
  type ByoDomainBundle,
} from '@/lib/byo-domain/bundle';
import { normalizeDomainInput } from '@/lib/dns-providers/domain';

function parseBundle(raw: unknown): ByoDomainBundle | null {
  const candidate = (raw && typeof raw === 'object' && 'bundle' in (raw as Record<string, unknown>))
    ? (raw as Record<string, unknown>).bundle
    : raw;
  if (!isByoDomainBundle(candidate)) return null;
  return { ...candidate, domain: normalizeDomainInput(candidate.domain) };
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return new Response('Unauthorized', { status: 401 });
  }
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }

  let bundle: ByoDomainBundle | null = null;
  try {
    bundle = parseBundle(await request.json());
  } catch {
    bundle = null;
  }
  if (!bundle) {
    return new Response(JSON.stringify({ error: 'Not a valid YouEye domain bundle (expected a youeye-byo-domain export)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // An expired cert is only recoverable when the bundle carries the DNS token
  // (the reconfigure re-issues via the provider). Fail loudly up front otherwise.
  if (!byoDomainBundleCertStillValid(bundle) && !bundle.dnsToken.included) {
    return new Response(JSON.stringify({ error: `The bundled certificate for ${bundle.domain} has expired and the bundle has no DNS token to issue a new one. Export a fresh bundle with --include-token.` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const appliedBundle = bundle;

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const result = await reconfigure(
          { domain: appliedBundle.domain, tls: 'byo-bundle', byoBundle: appliedBundle },
          (event) => send(event),
        );

        send({ complete: true, newUrl: result.newUrl });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('[domain apply] failed:', err);
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
