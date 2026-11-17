/**
 * CA Certificate Download API
 *
 * GET /api/setup/ca-cert — Download Caddy's internal CA root certificate.
 * Returns the PEM file for browser/OS trust store installation.
 */

import { readCaddyRootCertificate } from '@/lib/caddy/root-ca';

export async function GET() {
  try {
    const certificate = await readCaddyRootCertificate();
    if (!certificate) {
      return new Response('CA certificate not available', { status: 404 });
    }

    return new Response(certificate, {
      headers: {
        // The CA MIME type makes iOS and Android offer to install it; the body stays PEM.
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="youeye-ca.crt"',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Failed to retrieve CA certificate', { status: 500 });
  }
}
