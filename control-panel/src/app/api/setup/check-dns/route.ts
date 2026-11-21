/**
 * DNS Check API
 *
 * GET /api/setup/check-dns — Server-side check that Pi-Hole has the
 * wildcard DNS configured for the platform domain. Supplementary signal
 * alongside the client-side timing heuristic in SetupDnsExplainer.
 */

import { incusDownloadFile } from '@/lib/incus/server';
import { settingsService } from '@/lib/settings';

export async function GET() {
  try {
    const config = await settingsService.getRaw();
    const domain = config.domain;

    if (!domain) {
      return Response.json({ configured: false, domain: '', resolves_to: null });
    }

    // Check Pi-Hole dnsmasq_lines for address=/<domain>/<ip>. The file is read and matched here: the domain never
    // reaches a shell.
    let resolves_to: string | null = null;
    try {
      const toml = (await incusDownloadFile('youeye-pihole', '/etc/pihole/pihole.toml')).toString('utf8');
      const prefix = `address=/${domain}/`;
      for (const line of toml.split(/["\n,]/)) {
        const entry = line.trim();
        if (entry.startsWith(prefix) && entry.length > prefix.length) { resolves_to = entry.slice(prefix.length); break; }
      }
    } catch { /* Pi-hole not readable: not configured */ }

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
