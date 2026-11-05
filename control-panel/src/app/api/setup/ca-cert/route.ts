/**
 * CA Certificate Download API
 *
 * GET /api/setup/ca-cert — Download Caddy's internal CA root certificate.
 * Returns the PEM file for browser/OS trust store installation.
 */

import { execShell } from '@/lib/incus/server';

export async function GET() {
  try {
    const result = await execShell(
      'youeye-caddy',
      'cat /data/caddy/pki/authorities/local/root.crt',
      { timeout: 10000 }
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return new Response('CA certificate not available', { status: 404 });
    }

    return new Response(result.stdout, {
      headers: {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename="youeye-ca.crt"',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Failed to retrieve CA certificate', { status: 500 });
  }
}
