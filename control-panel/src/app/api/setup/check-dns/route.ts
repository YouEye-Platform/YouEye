/**
 * DNS Check API
 *
 * GET /api/setup/check-dns — Server-side check that Pi-Hole has the
 * wildcard DNS configured for the platform domain. Supplementary signal
 * alongside the client-side timing heuristic in SetupDnsExplainer.
 */

import { execShell } from '@/lib/incus/server';
import { settingsService } from '@/lib/settings';

export async function GET() {
  try {
    const config = await settingsService.getRaw();
    const domain = config.domain;

    if (!domain) {
      return Response.json({ configured: false, domain: '', resolves_to: null });
    }

    // Check Pi-Hole dnsmasq_lines for address=/<domain>/
    const tomlResult = await execShell(
      'youeye-pihole',
      `grep -o 'address=/${domain}/[^"]*' /etc/pihole/pihole.toml`,
      { timeout: 5000 },
    );

    let resolves_to: string | null = null;
    if (tomlResult.exitCode === 0 && tomlResult.stdout.trim()) {
      // Parse "address=/domain/IP" → extract IP
      const match = tomlResult.stdout.trim().match(/address=\/[^/]+\/(.+)/);
      if (match) resolves_to = match[1];
    }

    return Response.json({
      configured: resolves_to !== null,
      domain,
      resolves_to,
    });
  } catch {
    return Response.json(
      { configured: false, domain: '', resolves_to: null, error: 'Failed to check DNS' },
      { status: 500 },
    );
  }
}
