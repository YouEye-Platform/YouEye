/**
 * The Caddyfile the Control Panel loads when it deploys Caddy. The Control Panel then edits the live config through
 * the admin API (`client.ts`); `setDefaultRoute` adds the :80 setup server (`servers.ts`).
 *
 * - Admin API on Caddy's static incusbr0 address only. Off loopback, Caddy accepts only Hosts listed in `origins`;
 *   `*` matches nothing (every request got 403).
 * - No automatic HTTP->HTTPS redirects: the :80 setup server serves the box IP and `youeye.local` over HTTP and
 *   redirects every other host itself.
 * - Internal CA: Spine places the box root (`root.crt`/`root.key`) in `/data/caddy/pki/authorities/local/` before
 *   Caddy starts; Caddy makes and renews its own intermediate (30 days) and issues 7-day leaves on demand (Caddy's
 *   defaults are 7 days and 12 hours), so an owner who clicked through the warning doesn't see it every few hours.
 * - On-demand certificates ask the Control Panel first (`permission http`; Caddy 2.10 deprecated `ask`).
 */
export function controlPanelCaddyfile(adminAddress: string, controlIP: string): string {
  return [
    '{',
    `    admin ${adminAddress} {`,
    `        origins ${adminAddress}`,
    '    }',
    '    auto_https disable_redirects',
    '    pki {',
    '        ca local {',
    '            intermediate_lifetime 30d',
    '        }',
    '    }',
    '    on_demand_tls {',
    `        permission http http://${controlIP}:3000/api/setup/config`,
    '    }',
    '}',
    '',
    ':443 {',
    '    tls {',
    '        on_demand',
    '        issuer internal {',
    '            lifetime 7d',
    '        }',
    '    }',
    `    reverse_proxy ${controlIP}:3000`,
    '}',
    '',
  ].join('\n');
}
