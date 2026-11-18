/**
 * Caddy server layout, shared by every writer of the live config:
 *
 * - the main server listens on :443 and carries every YouEye and app route;
 * - `setup_http` listens on :80. It sends the box's local setup surface (an IPv4-literal Host, or exactly the
 *   mDNS name `youeye.local` / `youeye-<N>.local`) to the Control Panel over plain HTTP, and redirects every other
 *   host to HTTPS (308). App routes never go on it.
 *
 * Writers pick the main server by its listen address, never by key order: Caddy returns servers sorted by name.
 */

import type { CaddyConfig, CaddyRoute, HTTPServer } from './types';

export const SETUP_HTTP_SERVER = 'setup_http';

/** Caddy's internal issuer, with leaf certificates valid 7 days (Caddy's default is 12 h). */
export const INTERNAL_CERT_LIFETIME_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
export function internalIssuer(): { module: string; lifetime: number } {
  return { module: 'internal', lifetime: INTERNAL_CERT_LIFETIME_NS };
}

/** Service-auth headers that no request from outside may carry into a YouEye service. */
export const STRIPPED_REQUEST_HEADERS = [
  'X-Youeye-App',
  'X-Youeye-User',
  'X-Youeye-Username',
  'X-Youeye-Groups',
  'X-Youeye-Email',
  'X-Youeye-Name',
  'X-Youeye-Uid',
  'X-App-Slug',
  'X-Ui-Bridge-Token',
];

/** An IPv4-literal Host header, with an optional port. */
export const IPV4_HOST_PATTERN = '^\\d+\\.\\d+\\.\\d+\\.\\d+(:\\d+)?$';

/**
 * Exactly the box's mDNS names (`youeye.local`, `youeye-<N>.local` after an Avahi conflict) as a Host header, with
 * an optional port; case-insensitive (Go RE2 flag). Never any other `*.local`: that may be the platform domain.
 */
export const MDNS_HOST_PATTERN = '(?i)^youeye(-[0-9]{1,4})?\\.local(:[0-9]+)?$';

function listensOn(server: HTTPServer, port: number): boolean {
  return (server.listen ?? []).some((address) => address === `:${port}` || address.endsWith(`:${port}`));
}

function servers(config: CaddyConfig): Record<string, HTTPServer> {
  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};
  return config.apps.http.servers;
}

/**
 * Name of the server that carries the YouEye and app routes: the one listening on :443; else (a Caddy that fell
 * back to its stock config) the first server that is not the setup server, which `ensureHTTPSConfig` then moves to
 * :443; else `srv0`, to be created.
 */
export function mainServerName(config: CaddyConfig): string {
  const entries = Object.entries(servers(config)).filter(([name]) => name !== SETUP_HTTP_SERVER);
  return entries.find(([, server]) => listensOn(server, 443))?.[0] ?? entries[0]?.[0] ?? 'srv0';
}

/** The main server, created (listening on :443, no routes) when there is none. */
export function mainServer(config: CaddyConfig): HTTPServer {
  const all = servers(config);
  const name = mainServerName(config);
  if (!all[name]) all[name] = { listen: [':443'], routes: [], tls_connection_policies: [{}] };
  return all[name];
}

/** Every server that carries YouEye and app routes (all but the setup server). */
export function routeServers(config: CaddyConfig): HTTPServer[] {
  return Object.entries(config.apps?.http?.servers ?? {})
    .filter(([name]) => name !== SETUP_HTTP_SERVER)
    .map(([, server]) => server);
}

/** The :80 server for `controlDial` (the Control Panel's `ip:3000`). */
export function setupHttpServer(controlDial: string): HTTPServer {
  const routes: CaddyRoute[] = [
    {
      '@id': 'setup-http-header-strip',
      handle: [{ handler: 'headers', request: { delete: [...STRIPPED_REQUEST_HEADERS, 'X-Youeye-App-Token'] } }],
    },
    {
      '@id': 'setup-http-local',
      match: [
        { header_regexp: { Host: { pattern: MDNS_HOST_PATTERN } } },
        { header_regexp: { Host: { pattern: IPV4_HOST_PATTERN } } },
      ],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: controlDial }] }],
      terminal: true,
    },
    {
      '@id': 'setup-http-redirect',
      handle: [{
        handler: 'static_response',
        status_code: 308,
        headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
      }],
      terminal: true,
    },
  ];
  return { listen: [':80'], routes };
}

/**
 * Put the canonical setup server for `controlDial` into `config`, and take :80 off every other server (two servers
 * cannot share a listener). Returns whether anything changed.
 */
export function applySetupHttpServer(config: CaddyConfig, controlDial: string): boolean {
  const all = servers(config);
  const before = canonicalJSON(all);
  for (const [name, server] of Object.entries(all)) {
    if (name === SETUP_HTTP_SERVER) continue;
    server.listen = (server.listen ?? []).filter((address) => address !== ':80' && !address.endsWith(':80'));
  }
  all[SETUP_HTTP_SERVER] = setupHttpServer(controlDial);
  return canonicalJSON(all) !== before;
}

/** JSON with object keys sorted, as Caddy returns its config (Go encodes maps sorted). */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item);
}
