/**
 * Caddy server layout, shared by every writer of the live config:
 *
 * - the main server listens on :443 and carries every YouEye and app route;
 * - `setup_http` listens on :80. It sends the box's local setup surface (an IPv4-literal Host, or exactly the
 *   mDNS name `youeye.local` / `youeye-<N>.local`) to the Control Panel over plain HTTP, and redirects every other
 *   host to HTTPS (308). App routes never go on it.
 *
 * Writers pick the main server by its listen address, never by key order: Caddy returns servers sorted by name.
 *
 * Every server on :80 or :443 reads a PROXY protocol header first (`clientAddressListenerWrappers`), then TLS.
 * LAN and internet clients reach Caddy through `youeye-caddy`'s Incus proxy devices, which connect from 127.0.0.1;
 * with `proxy_protocol: "true"` on a device it puts the real client's address in front of the connection, and only
 * 127.0.0.1 may do that. A plain connection (no header) from 127.0.0.1 is still served as before, so the wrapper
 * changes nothing until the devices send headers. `setConfig` puts the wrappers on every write; a device must never
 * send headers to a server without them (`client-address.ts`).
 */

import type { CaddyConfig, CaddyRoute, HTTPServer, ListenerWrapper } from './types';

export const SETUP_HTTP_SERVER = 'setup_http';

/** The only source that may send a PROXY header: Caddy's own end of the Incus proxy devices (`connect 127.0.0.1`). */
export const PROXY_DEVICE_SOURCE = '127.0.0.1/32';

/** The ports `youeye-caddy`'s proxy devices forward, and so the ports whose servers carry the wrappers. */
export const CLIENT_ADDRESS_PORTS = [80, 443] as const;

/**
 * `proxy_protocol` (from 127.0.0.1 only: a header is used when present, a plain connection is served as it is;
 * from any other source a header is ignored), then `tls` (without it Caddy would do TLS before reading the header).
 */
export function clientAddressListenerWrappers(): ListenerWrapper[] {
  return [{ wrapper: 'proxy_protocol', allow: [PROXY_DEVICE_SOURCE] }, { wrapper: 'tls' }];
}

/** Whether `server` reads a PROXY header from 127.0.0.1 first, and TLS comes after it. */
export function hasClientAddressListenerWrappers(server: HTTPServer): boolean {
  const [proxy, ...rest] = server.listener_wrappers ?? [];
  return proxy?.wrapper === 'proxy_protocol'
    && Array.isArray(proxy.allow) && proxy.allow.includes(PROXY_DEVICE_SOURCE)
    && rest.some((wrapper) => wrapper?.wrapper === 'tls');
}

/** The servers of `config` that listen on `port`. */
export function serversOnPort(config: CaddyConfig, port: number): HTTPServer[] {
  return Object.values(config.apps?.http?.servers ?? {}).filter((server) => listensOn(server, port));
}

/**
 * Whether a device on `port` may send PROXY headers: some server listens on it and every one of them has the
 * wrappers. Without a server of our own on :80, Caddy's automatic redirect server would take it, without wrappers.
 */
export function portReadsClientAddresses(config: CaddyConfig, port: number): boolean {
  const on = serversOnPort(config, port);
  return on.length > 0 && on.every(hasClientAddressListenerWrappers);
}

/**
 * Put `proxy_protocol` first on every server that listens on :80 or :443. Other wrappers keep their place relative
 * to `tls` (`http_redirect` must come before it); without a `tls` wrapper, Caddy runs TLS first, so `tls` goes right
 * after `proxy_protocol`. Returns whether anything changed.
 */
export function applyClientAddressListenerWrappers(config: CaddyConfig): boolean {
  let changed = false;
  for (const server of Object.values(config.apps?.http?.servers ?? {})) {
    if (!CLIENT_ADDRESS_PORTS.some((port) => listensOn(server, port))) continue;
    const [proxy, tls] = clientAddressListenerWrappers();
    const rest = (server.listener_wrappers ?? []).filter((wrapper) => wrapper?.wrapper !== 'proxy_protocol');
    const next = rest.some((wrapper) => wrapper?.wrapper === 'tls') ? [proxy, ...rest] : [proxy, tls, ...rest];
    if (canonicalJSON(next) !== canonicalJSON(server.listener_wrappers ?? null)) {
      server.listener_wrappers = next;
      changed = true;
    }
  }
  return changed;
}

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

/** A new main server: :443 with the client-address wrappers and TLS, no routes. */
export function newMainServer(): HTTPServer {
  return { listen: [':443'], listener_wrappers: clientAddressListenerWrappers(), routes: [], tls_connection_policies: [{}] };
}

/** The main server, created (listening on :443, no routes) when there is none. */
export function mainServer(config: CaddyConfig): HTTPServer {
  const all = servers(config);
  const name = mainServerName(config);
  if (!all[name]) all[name] = newMainServer();
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
      handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: controlDial }],
        load_balancing: { try_duration: CONTROL_PANEL_TRY_DURATION, try_interval: CONTROL_PANEL_TRY_INTERVAL },
      }],
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
  return { listen: [':80'], listener_wrappers: clientAddressListenerWrappers(), routes };
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

/**
 * How Caddy proxies to the Control Panel's container (YE-138). A Control Panel restart (the one setup asks for to
 * load its sign-in settings, a URL change, a restore, an update) leaves its port closed for a moment, about 0.3 s
 * on a test box: Caddy answered every request in that moment with 502. With `try_duration` Caddy keeps dialling,
 * every `try_interval`, for up to that long, and the request reaches the new process instead. Caddy retries a
 * request it could not deliver (the dial failed: it never reached the Control Panel, whatever its method) and a GET
 * whose connection broke (a GET in flight when the old process stopped is sent again to the new one). A POST that
 * reached the old process is never sent again. When the Control Panel's container is really down a request now waits
 * that long before its 502, and so does a request to an app with sign-in, whose forward-auth check goes to YouEye ID.
 */
export const CONTROL_PANEL_TRY_DURATION = '10s';
export const CONTROL_PANEL_TRY_INTERVAL = '250ms';

/**
 * Give every `reverse_proxy` handler whose upstreams are all `controlDials` (the Control Panel's container: its
 * :3000 and YouEye ID's :3001, by address or by name) the retry above, wherever it is in `config` (routes,
 * subroutes, forward-auth responses). Other handlers and the handler's other load-balancing settings stay as they
 * are. Returns whether anything changed. `setConfig` runs it on every write and the managed-route reconcile at every
 * Control Panel start, so a box updated from a release without it converges then.
 */
export function applyControlPanelRetry(config: unknown, controlDials: ReadonlySet<string>): boolean {
  let changed = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const upstreams = record.upstreams;
    if (record.handler === 'reverse_proxy' && Array.isArray(upstreams) && upstreams.length > 0
      && upstreams.every((upstream) => typeof upstream?.dial === 'string' && controlDials.has(upstream.dial))) {
      const current = record.load_balancing && typeof record.load_balancing === 'object'
        ? record.load_balancing as Record<string, unknown> : {};
      if (current.try_duration !== CONTROL_PANEL_TRY_DURATION || current.try_interval !== CONTROL_PANEL_TRY_INTERVAL) {
        record.load_balancing = { ...current, try_duration: CONTROL_PANEL_TRY_DURATION, try_interval: CONTROL_PANEL_TRY_INTERVAL };
        changed = true;
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(config);
  return changed;
}

/** JSON with object keys sorted, as Caddy returns its config (Go encodes maps sorted). */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item);
}
