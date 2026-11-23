import { PROXY_DEVICE_SOURCE } from './servers';

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
 * - Every server reads a PROXY header from 127.0.0.1 before TLS, like every config the Control Panel writes
 *   (`clientAddressListenerWrappers` in `servers.ts`).
 */
export function controlPanelCaddyfile(adminAddress: string, controlIP: string): string {
  return [
    '{',
    `    admin ${adminAddress} {`,
    `        origins ${adminAddress}`,
    '    }',
    '    auto_https disable_redirects',
    '    servers {',
    '        listener_wrappers {',
    '            proxy_protocol {',
    `                allow ${PROXY_DEVICE_SOURCE}`,
    '            }',
    '            tls',
    '        }',
    '    }',
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

/** The Caddyfile in the `youeye-caddy` container: what Caddy loads when it starts without a saved config. */
export const CONTAINER_CADDYFILE = '/etc/caddy/Caddyfile';

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Whether a Caddyfile puts the PROXY protocol listener wrapper (allowing the proxy devices' source) before `tls` on
 * every server, as `controlPanelCaddyfile` does. A Caddyfile written by a deploy before 0.6.16 has none.
 */
export function caddyfileReadsClientAddresses(caddyfile: string): boolean {
  return new RegExp('(^|\\s)servers\\s*\\{\\s*listener_wrappers\\s*\\{\\s*proxy_protocol\\s*\\{[^}]*\\ballow\\s[^}\\n]*'
    + `${escaped(PROXY_DEVICE_SOURCE)}(\\s[^}]*)?\\}\\s*tls\\s*\\}`).test(caddyfile);
}

export interface ContainerCaddyfileIO {
  /** Whether the `youeye-caddy` container exists (not before the first deploy). */
  exists(): Promise<boolean>;
  /** The container's Caddyfile, or null when it has none. */
  read(): Promise<string | null>;
  /** Caddy's admin address and the Control Panel's static address (null when it has none). */
  addresses(): Promise<{ adminAddress: string; controlIP: string | null }>;
  /** Replace the container's Caddyfile, checked by Caddy before it takes the place of the old one. */
  write(caddyfile: string): Promise<void>;
}

const runtimeIO: ContainerCaddyfileIO = {
  exists: async () => (await import('../infrastructure/oci-deployer')).containerExists('youeye-caddy'),
  read: async () => {
    const { execShell } = await import('../incus/server');
    const result = await execShell('youeye-caddy', `[ -e ${CONTAINER_CADDYFILE} ] || exit 3; cat ${CONTAINER_CADDYFILE}`, { timeout: 15000 });
    if (result.exitCode === 3) return null;
    if (result.exitCode !== 0) throw new Error(`Reading the Caddyfile failed (exit ${result.exitCode}): ${result.stderr}`);
    return result.stdout;
  },
  addresses: async () => {
    const { caddyAdminAddress } = await import('./client');
    const { getSystemStaticIP } = await import('../incus/static-ips');
    return { adminAddress: await caddyAdminAddress(), controlIP: await getSystemStaticIP('youeye-control') };
  },
  write: async (caddyfile) => {
    const { execShell } = await import('../incus/server');
    const next = `${CONTAINER_CADDYFILE}.youeye-new`;
    const b64 = Buffer.from(caddyfile).toString('base64');
    const result = await execShell('youeye-caddy',
      `echo '${b64}' | base64 -d > ${next} && caddy adapt --config ${next} --adapter caddyfile > /dev/null `
      + `&& mv -f ${next} ${CONTAINER_CADDYFILE} || { rm -f ${next}; exit 1; }`, { timeout: 15000 });
    if (result.exitCode !== 0) throw new Error(`Writing the Caddyfile failed (exit ${result.exitCode}): ${result.stderr}`);
  },
};

/**
 * At every Control Panel start (YE-140): the container's Caddyfile gets the PROXY protocol listener wrappers when it
 * lacks them (a box deployed before 0.6.16; only a deploy wrote it). Caddy runs its saved config (`--resume`,
 * `autosave.json`), which the Control Panel keeps with the wrappers; the Caddyfile is what Caddy loads when that is
 * lost or unreadable, and without the wrappers :443 and :80 would not answer the proxy devices' PROXY headers until
 * the health monitor's next check turned them off. The file is replaced with the deploy's Caddyfile
 * (`controlPanelCaddyfile`), checked by `caddy adapt` first; the running Caddy is not reloaded (its config stays). A
 * Control Panel without its static address writes nothing (the deploy's name fallback may not resolve in Caddy).
 * Returns whether it wrote.
 */
export async function ensureContainerCaddyfile(io: ContainerCaddyfileIO = runtimeIO): Promise<boolean> {
  if (!await io.exists()) return false;
  const current = await io.read();
  if (current !== null && caddyfileReadsClientAddresses(current)) return false;
  const { adminAddress, controlIP } = await io.addresses();
  if (!controlIP) throw new Error('The Control Panel has no static address; the Caddyfile was left as it is');
  await io.write(controlPanelCaddyfile(adminAddress, controlIP));
  return true;
}
