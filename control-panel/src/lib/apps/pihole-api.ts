/**
 * Pi-Hole FTL v6 API Client
 *
 * Handles session-based authentication and API requests for Pi-Hole FTL v6+.
 * The new FTL API uses:
 * - POST /api/auth with JSON {"password": "xxx"} to get a session ID (SID)
 * - Include SID in Cookie header or sid query param for authenticated requests
 *
 * API endpoints:
 * - /api/stats/summary - Dashboard stats
 * - /api/queries - Query log
 * - /api/domains - Domain lists (whitelist/blacklist)
 * - /api/dns/blocking - Enable/disable blocking
 * - /api/config/dns/hosts - Custom DNS records
 * - /api/config/dns/cnameRecords - CNAME records
 */

import { getContainerIP } from '@/lib/incus/container-ip';
import { getPiholePassword } from '@/lib/apps/secrets';
import { PIHOLE_MANIFEST } from '@/lib/apps/manifest';

const CONTAINER_NAME = PIHOLE_MANIFEST.containerName;

interface PiholeSession {
  sid: string;
  csrf: string;
  validity: number;
  createdAt: number;
}

// Cache session to avoid re-authenticating on every request
let cachedSession: PiholeSession | null = null;

// Lock to prevent parallel authentication attempts (Pi-Hole rate-limits auth to avoid 429)
let authPromise: Promise<PiholeSession> | null = null;

/**
 * Get Pi-Hole container IP
 */
async function getPiholeIP(): Promise<string> {
  const ip = await getContainerIP(CONTAINER_NAME);
  if (!ip) {
    throw new Error('Pi-Hole container not running');
  }
  return ip;
}

/**
 * Authenticate with Pi-Hole and get session
 *
 * If the stored password is rejected, the Pi-Hole password may have been
 * changed out-of-band (e.g. via pihole CLI).  In that case we re-read the
 * password from Spine and re-sync Pi-Hole, then retry once.
 */
async function authenticate(retried = false): Promise<PiholeSession> {
  const ip = await getPiholeIP();
  const password = await getPiholePassword();

  const response = await fetch(`http://${ip}:80/api/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });

  // Pi-Hole FTL v6 returns HTTP 401 on a wrong password.
  // Older v5 returned 200 with `session.valid:false`. Treat both as
  // "password rejected" and trigger the same recovery path so the
  // self-healing `pihole setpassword` resync works on FTL v6.
  let data: { session?: { valid?: boolean; sid?: string; csrf?: string; validity?: number; message?: string } } = {};
  if (response.ok) {
    data = await response.json();
  }
  const passwordRejected =
    response.status === 401 || (response.ok && !data.session?.valid);

  if (passwordRejected) {
    if (!retried) {
      console.warn('[PiHole] Password rejected, attempting re-sync from Spine...');
      try {
        await resyncPiholePassword(ip, password);
        return authenticate(true);
      } catch (syncErr) {
        console.error('[PiHole] Password re-sync failed:', syncErr);
      }
    }
    throw new Error(
      data.session?.message || `Authentication failed: ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status}`);
  }

  // At this point response was OK and session.valid was true, so the
  // session fields are guaranteed present.
  const session = data.session!;
  return {
    sid: session.sid as string,
    csrf: session.csrf as string,
    validity: session.validity as number,
    createdAt: Date.now(),
  };
}

/**
 * Re-sync Pi-Hole password by calling `pihole setpassword` via Incus exec.
 * This handles the case where Pi-Hole's password hash gets out of sync
 * with the password stored in Spine (e.g. after a Pi-Hole update or restore).
 */
async function resyncPiholePassword(ip: string, password: string): Promise<void> {
  const { incusRequest: incReq } = await import('@/lib/incus/server');

  // FTL v6 locks out `pihole setpassword` when FTLCONF_webserver_api_password
  // is set as a container env var (exits code 5). Check for and remove the
  // env var override before attempting setpassword.
  const containerResp = await incReq<{ config?: Record<string, string> }>(
    'GET',
    `/1.0/instances/${CONTAINER_NAME}`
  );
  const cfg = containerResp.metadata?.config ?? {};
  const hasEnvOverride = !!cfg['environment.FTLCONF_webserver_api_password'];
  if (hasEnvOverride) {
    console.log('[PiHole] Removing FTLCONF_webserver_api_password env var override (blocks pihole setpassword)');
    await incReq('PATCH', `/1.0/instances/${CONTAINER_NAME}`, {
      config: { 'environment.FTLCONF_webserver_api_password': '' },
    });
    // Also remove legacy v5 var if present
    if (cfg['environment.WEBPASSWORD']) {
      await incReq('PATCH', `/1.0/instances/${CONTAINER_NAME}`, {
        config: { 'environment.WEBPASSWORD': '' },
      });
    }
    // Restart so FTL stops reading the env var
    await incReq('PUT', `/1.0/instances/${CONTAINER_NAME}/state`, {
      action: 'restart', timeout: 30, force: false,
    });
    // Wait for Pi-Hole to come back up
    await new Promise((r) => setTimeout(r, 5000));
  }

  const execResponse = await incReq<{
    return: number;
    output?: string;
  }>(
    'POST',
    `/1.0/instances/${CONTAINER_NAME}/exec`,
    {
      command: ['pihole', 'setpassword', password],
      'record-output': true,
      'wait-for-websocket': false,
    }
  );

  if (execResponse.operation) {
    const opId = execResponse.operation.split('/').pop();
    await incReq('GET', `/1.0/operations/${opId}/wait?timeout=15`);
  }

  // After `pihole setpassword` finishes, FTL has a brief window (~400-500ms
  // measured on FTL v6) where it has invalidated the old password hash but
  // hasn't loaded the new one yet — auth requests during this window return
  // HTTP 401. Wait long enough that subsequent auth attempts see the new
  // password. Without this sleep, the immediate retry inside `authenticate()`
  // (and any external `withRetry` wrapper with a zero first delay) gets a
  // spurious 401 and the recovery path fails on its first attempt.
  await new Promise((r) => setTimeout(r, 2000));

  console.log('[PiHole] Password re-synced via pihole setpassword');
}

/**
 * Get valid session (cached or new)
 * Uses a lock to prevent parallel authenticate() calls that trigger Pi-Hole 429 rate-limiting
 */
async function getSession(): Promise<PiholeSession> {
  // Check if cached session is still valid (with 60s buffer)
  if (cachedSession) {
    const elapsed = (Date.now() - cachedSession.createdAt) / 1000;
    if (elapsed < cachedSession.validity - 60) {
      return cachedSession;
    }
  }

  // If another request is already authenticating, wait for it
  if (authPromise) {
    return authPromise;
  }

  // Authenticate with lock to prevent parallel calls
  authPromise = authenticate().then(session => {
    cachedSession = session;
    authPromise = null;
    return session;
  }).catch(err => {
    authPromise = null;
    throw err;
  });

  return authPromise;
}

/**
 * Clear cached session (e.g., after password change)
 */
export function clearPiholeSession(): void {
  cachedSession = null;
}

/**
 * Make authenticated request to Pi-Hole API
 * Note: Pi-Hole FTL v6 requires SID as URL parameter, NOT Cookie header
 */
export async function piholeRequest<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const ip = await getPiholeIP();
  const session = await getSession();

  // Pi-Hole FTL v6 requires SID in URL parameter, not Cookie
  const urlWithSid = endpoint.includes('?')
    ? `http://${ip}:80${endpoint}&sid=${session.sid}`
    : `http://${ip}:80${endpoint}?sid=${session.sid}`;
  
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // Add CSRF token for POST/PUT/DELETE
  if (
    options.method &&
    ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method.toUpperCase())
  ) {
    headers['X-FTL-CSRF'] = session.csrf;
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(urlWithSid, {
    ...options,
    headers,
  });

  if (!response.ok) {
    // If unauthorized, clear session and retry once
    if (response.status === 401 && cachedSession) {
      cachedSession = null;
      return piholeRequest<T>(endpoint, options);
    }

    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || `API request failed: ${response.status}`
    );
  }

  return response.json();
}

/**
 * Get Pi-Hole stats summary
 *
 * Pi-Hole FTL v6 serves blocking status at /api/dns/blocking (not in /api/stats/summary),
 * so we fetch both endpoints in parallel.
 */
export async function getStats(): Promise<{
  domainsBlocked: number;
  queriesToday: number;
  adsBlockedToday: number;
  adsPercentage: number;
  status: string;
}> {
  const [summaryData, blockingData] = await Promise.all([
    piholeRequest<{
      queries: { total: number; blocked: number; percent_blocked: number };
      gravity: { domains_being_blocked: number };
    }>('/api/stats/summary'),
    piholeRequest<{
      blocking: string;
    }>('/api/dns/blocking').catch(() => ({ blocking: 'unknown' })),
  ]);

  return {
    domainsBlocked: summaryData.gravity?.domains_being_blocked || 0,
    queriesToday: summaryData.queries?.total || 0,
    adsBlockedToday: summaryData.queries?.blocked || 0,
    adsPercentage: summaryData.queries?.percent_blocked || 0,
    status: blockingData.blocking || 'unknown',
  };
}

/**
 * Get query log
 */
export async function getQueryLog(
  limit: number = 100
): Promise<
  Array<{
    id: number;
    timestamp: number;
    type: string;
    domain: string;
    client: string;
    status: string;
    replyTime?: number;
  }>
> {
  const data = await piholeRequest<{
    queries: Array<{
      id: number;
      time: number;
      type: string;
      domain: string;
      client: { ip: string };
      status: string;
      reply: { time: number };
    }>;
  }>(`/api/queries?length=${limit}`);

  return (data.queries || []).map((q) => ({
    id: q.id,
    timestamp: q.time,
    type: q.type,
    domain: q.domain,
    client: q.client?.ip || 'unknown',
    status: q.status,
    replyTime: q.reply?.time,
  }));
}

/**
 * Get custom DNS records
 */
export async function getDNSRecords(): Promise<
  Array<{
    ip: string;
    domain: string;
  }>
> {
  const data = await piholeRequest<{
    config: {
      dns: {
        hosts: string[];
      };
    };
  }>('/api/config/dns');

  // hosts format: "IP domain"
  return (data.config?.dns?.hosts || []).map((entry) => {
    const [ip, domain] = entry.split(' ');
    return { ip: ip || '', domain: domain || '' };
  });
}

/**
 * Add custom DNS record
 */
export async function addDNSRecord(ip: string, domain: string): Promise<void> {
  // First get existing hosts
  const current = await piholeRequest<{
    config: { dns: { hosts: string[] } };
  }>('/api/config/dns');

  const hosts = [...(current.config?.dns?.hosts || []), `${ip} ${domain}`];

  await piholeRequest('/api/config/dns', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        dns: {
          hosts,
        },
      },
    }),
  });
}

/**
 * Remove custom DNS record
 */
export async function removeDNSRecord(
  ip: string,
  domain: string
): Promise<void> {
  const current = await piholeRequest<{
    config: { dns: { hosts: string[] } };
  }>('/api/config/dns');

  const hosts = (current.config?.dns?.hosts || []).filter(
    (entry) => entry !== `${ip} ${domain}`
  );

  await piholeRequest('/api/config/dns', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        dns: {
          hosts,
        },
      },
    }),
  });
}

/**
 * Get CNAME records
 */
export async function getCNAMERecords(): Promise<
  Array<{
    domain: string;
    target: string;
  }>
> {
  const data = await piholeRequest<{
    config: {
      dns: {
        cnameRecords: string[];
      };
    };
  }>('/api/config/dns');

  // cnameRecords format: "domain,target"
  return (data.config?.dns?.cnameRecords || []).map((entry) => {
    const [domain, target] = entry.split(',');
    return { domain: domain || '', target: target || '' };
  });
}

/**
 * Add CNAME record
 */
export async function addCNAMERecord(
  domain: string,
  target: string
): Promise<void> {
  const current = await piholeRequest<{
    config: { dns: { cnameRecords: string[] } };
  }>('/api/config/dns');

  const cnameRecords = [
    ...(current.config?.dns?.cnameRecords || []),
    `${domain},${target}`,
  ];

  await piholeRequest('/api/config/dns', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        dns: {
          cnameRecords,
        },
      },
    }),
  });
}

/**
 * Remove CNAME record
 */
export async function removeCNAMERecord(
  domain: string,
  target: string
): Promise<void> {
  const current = await piholeRequest<{
    config: { dns: { cnameRecords: string[] } };
  }>('/api/config/dns');

  const cnameRecords = (current.config?.dns?.cnameRecords || []).filter(
    (entry) => entry !== `${domain},${target}`
  );

  await piholeRequest('/api/config/dns', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        dns: {
          cnameRecords,
        },
      },
    }),
  });
}

/**
 * Enable/disable blocking
 * @param enabled - true to enable blocking, false to disable
 * @param timer - optional duration in seconds to disable (only for disable)
 */
export async function setBlocking(enabled: boolean, timer?: number): Promise<void> {
  const body: { blocking: boolean; timer?: number } = { blocking: enabled };
  if (!enabled && timer && timer > 0) {
    body.timer = timer;
  }
  
  await piholeRequest('/api/dns/blocking', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Get domain lists (whitelist/blacklist)
 */
export async function getDomainLists(): Promise<{
  whitelist: string[];
  blacklist: string[];
}> {
  const [whiteData, blackData] = await Promise.all([
    piholeRequest<{ domains: Array<{ domain: string }> }>(
      '/api/domains/allow/exact'
    ),
    piholeRequest<{ domains: Array<{ domain: string }> }>(
      '/api/domains/deny/exact'
    ),
  ]);

  return {
    whitelist: (whiteData.domains || []).map((d) => d.domain),
    blacklist: (blackData.domains || []).map((d) => d.domain),
  };
}

// ─── Wildcard DNS via dnsmasq address= directives ────────────────────────────

/**
 * Get current custom dnsmasq lines from Pi-Hole config
 */
async function getDnsmasqLines(): Promise<string[]> {
  const data = await piholeRequest<{
    config: { misc: { dnsmasq_lines: string[] } };
  }>('/api/config/misc');
  return data.config?.misc?.dnsmasq_lines || [];
}

/**
 * Set custom dnsmasq lines in Pi-Hole config
 */
async function setDnsmasqLines(lines: string[]): Promise<void> {
  await piholeRequest('/api/config/misc', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        misc: {
          dnsmasq_lines: lines,
        },
      },
    }),
  });
}

/**
 * Set wildcard DNS for a domain pointing to the server's LAN IP.
 * Uses dnsmasq `address=/domain/IP` which resolves the domain AND all subdomains.
 * Automatically removes previous entries for the old domain if provided.
 */
export async function setDomainDNS(
  domain: string,
  serverIP: string,
  oldDomain?: string
): Promise<void> {
  const lines = await getDnsmasqLines();

  // Domains to clean up
  const domainsToRemove = new Set([domain]);
  if (oldDomain && oldDomain !== domain) {
    domainsToRemove.add(oldDomain);
  }

  // Filter out old YouEye address= entries for these domains
  const filtered = lines.filter((line) => {
    for (const d of domainsToRemove) {
      if (line.startsWith(`address=/${d}/`)) {
        return false;
      }
    }
    return true;
  });

  // Add new entry: address=/domain.com/IP resolves domain.com AND *.domain.com
  filtered.push(`address=/${domain}/${serverIP}`);

  await setDnsmasqLines(filtered);
}

/**
 * Remove all DNS address= entries for a domain
 */
export async function removeDomainDNS(domain: string): Promise<void> {
  const lines = await getDnsmasqLines();
  const filtered = lines.filter(
    (line) => !line.startsWith(`address=/${domain}/`)
  );
  if (filtered.length !== lines.length) {
    await setDnsmasqLines(filtered);
  }
}

// ─── Domain lists ────────────────────────────────────────────────────────────

/**
 * Add domain to list
 */
export async function addDomain(
  domain: string,
  list: 'whitelist' | 'blacklist'
): Promise<void> {
  const type = list === 'whitelist' ? 'allow' : 'deny';
  await piholeRequest(`/api/domains/${type}/exact`, {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
}

/**
 * Remove domain from list
 */
export async function removeDomain(
  domain: string,
  list: 'whitelist' | 'blacklist'
): Promise<void> {
  const type = list === 'whitelist' ? 'allow' : 'deny';
  await piholeRequest(`/api/domains/${type}/exact/${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
}

// ─── Upstream DNS servers ───────────────────────────────────────────────────

/**
 * Get current upstream DNS servers
 */
export async function getUpstreamDNS(): Promise<string[]> {
  const data = await piholeRequest<{
    config: { dns: { upstreams: string[] } };
  }>('/api/config/dns');
  return data.config?.dns?.upstreams || [];
}

/**
 * Set upstream DNS servers (replaces the full list)
 */
export async function setUpstreamDNS(servers: string[]): Promise<string[]> {
  const data = await piholeRequest<{
    config: { dns: { upstreams: string[] } };
  }>('/api/config/dns', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        dns: {
          upstreams: servers,
        },
      },
    }),
  });
  return data.config?.dns?.upstreams || [];
}
