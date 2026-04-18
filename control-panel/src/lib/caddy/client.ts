/**
 * Caddy API Client
 * 
 * Communicates with Caddy's admin API (port 2019).
 * Used server-side to manage reverse proxy routes and TLS.
 * 
 * Security: The Caddy admin API is only accessible via Incus internal network.
 * Port 2019 is NOT exposed to the host, preventing unauthorized access.
 */

import type {
  CaddyConfig,
  CaddyRoute,
  ProxyRoute,
  RouteFormData,
  CaddyStatus,
  HTTPServer,
} from './types';

import http from 'http';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

/**
 * Default Caddy admin API URL
 * Uses the container's internal DNS name (only accessible from Incus network)
 */
const DEFAULT_CADDY_URL = `http://youeye-caddy.${CONTAINER_DOMAIN}:2019`;

/**
 * Connection timeout for Caddy API requests (ms)
 */
const REQUEST_TIMEOUT = 10000;

/**
 * Get Caddy admin URL from environment or use default
 */
function getCaddyUrl(): string {
  return process.env.CADDY_ADMIN_URL || DEFAULT_CADDY_URL;
}

/**
 * Make an HTTP request using Node's http module.
 * We use http.request instead of fetch because Node.js fetch automatically
 * adds an empty Origin header that Caddy's admin API rejects with 403.
 */
function httpRequest(
  method: string,
  urlStr: string,
  body?: string,
  timeoutMs: number = REQUEST_TIMEOUT
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Make a request to Caddy's admin API with timeout and retry
 */
async function caddyRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  retries: number = 2
): Promise<T> {
  const url = `${getCaddyUrl()}${path}`;
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const response = await httpRequest(method, url, bodyStr, REQUEST_TIMEOUT);

      if (response.status >= 400) {
        throw new Error(`Caddy API error: ${response.status} - ${response.body}`);
      }

      // Some endpoints return empty response
      if (!response.body) return {} as T;

      return JSON.parse(response.body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on non-network errors (like 400 Bad Request)
      if (lastError.message.includes('Caddy API error:')) {
        throw lastError;
      }
      
      // Wait before retry (exponential backoff)
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        console.log(`[Caddy] Retrying request to ${path} (attempt ${attempt + 2}/${retries + 1})`);
      }
    }
  }
  
  throw lastError || new Error('Caddy request failed');
}

/**
 * Get the full Caddy configuration
 */
export async function getConfig(): Promise<CaddyConfig> {
  return caddyRequest<CaddyConfig>('GET', '/config/');
}

/**
 * Set the full Caddy configuration.
 * Caddy's --resume flag auto-saves to /config/caddy/autosave.json,
 * so config survives container restarts without manual persistence.
 */
export async function setConfig(config: CaddyConfig): Promise<void> {
  // Ensure admin config allows API access from any origin.
  // Caddy's default origins check rejects requests when the Origin header
  // doesn't match. Setting enforce_origin: false and clearing origins
  // prevents 403 errors from control panel API calls.
  if (!config.admin) {
    config.admin = { listen: '0.0.0.0:2019' };
  }
  config.admin.enforce_origin = false;
  delete config.admin.origins;

  await caddyRequest('POST', '/load', config);
}

/**
 * Get Caddy status
 */
export async function getStatus(): Promise<CaddyStatus> {
  try {
    const config = await getConfig();
    return {
      running: true,
      config,
    };
  } catch {
    return {
      running: false,
    };
  }
}

/**
 * Generate a unique route ID
 */
function generateRouteId(): string {
  return `route-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Check if a string looks like an IP address
 */
function isIPAddress(str: string): boolean {
  // IPv4
  const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  // IPv6 (simplified)
  const ipv6Regex = /^([0-9a-fA-F]*:)+[0-9a-fA-F]*$/;
  return ipv4Regex.test(str) || ipv6Regex.test(str);
}

/**
 * Normalize upstream address for Incus DNS resolution
 * Container names need the bridge DNS suffix for inter-container communication
 */
function normalizeUpstream(upstream: string): string {
  // If it's already a FQDN with the container domain, return as-is
  if (upstream.endsWith(`.${CONTAINER_DOMAIN}`)) {
    return upstream;
  }

  // Also accept legacy .incus suffix
  if (upstream.endsWith('.incus')) {
    return upstream.replace(/\.incus$/, `.${CONTAINER_DOMAIN}`);
  }

  // If it's an IP address, return as-is
  if (isIPAddress(upstream)) {
    return upstream;
  }

  // If it contains a dot (other domain), return as-is
  if (upstream.includes('.')) {
    return upstream;
  }

  // Container name without suffix — add container domain for DNS
  return `${upstream}.${CONTAINER_DOMAIN}`;
}

/**
 * Normalize a path pattern for Caddy matching
 * Ensures paths are in the correct format: /path/* for prefix matching
 * 
 * @returns { normalized: string, warning?: string }
 */
export function normalizePathPattern(path: string | undefined): { normalized: string; warning?: string } {
  // Default to root catch-all
  if (!path || path === '/' || path === '/*') {
    return { normalized: '/*' };
  }
  
  let normalized = path.trim();
  let warning: string | undefined;
  const originalPath = normalized;
  
  // Ensure leading slash
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  
  // Remove trailing * for processing
  if (normalized.endsWith('*')) {
    normalized = normalized.slice(0, -1);
  }
  
  // Remove trailing slash for consistency
  if (normalized.endsWith('/') && normalized !== '/') {
    normalized = normalized.slice(0, -1);
  }
  
  // Add /* suffix for prefix matching
  // IMPORTANT: Caddy's * doesn't cross path separators!
  // /control* matches /control, /controlABC but NOT /control/dashboard
  // /control/* matches /control/, /control/dashboard, etc.
  normalized = normalized + '/*';
  
  // Generate warning if we modified the path significantly
  if (originalPath !== normalized && originalPath !== normalized.slice(0, -2) && originalPath !== normalized.slice(0, -1)) {
    warning = `Path normalized: "${originalPath}" → "${normalized}"`;
  }
  
  return { normalized, warning };
}

/**
 * Convert form data to Caddy route
 * Includes path stripping when path is not root
 */
export function formDataToRoute(data: RouteFormData): { route: CaddyRoute; warning?: string } {
  // Build handlers array
  const handlers: CaddyRoute['handle'] = [];

  // Forward-auth handler (prepended before all other handlers)
  if (data.forwardAuth) {
    handlers.push({
      handler: 'forward_auth',
      uri: data.forwardAuth.uri,
      copy_headers: data.forwardAuth.copyHeaders,
      trust_forwarded_headers: true,
    });
  }

  // Normalize path pattern
  const { normalized: normalizedPath, warning } = normalizePathPattern(data.path);
  const isRootPath = normalizedPath === '/*';

  // Add path stripping rewrite if path is not root
  // This makes /control/dashboard -> /dashboard
  if (!isRootPath) {
    // Strip the /* suffix to get the prefix to strip
    const stripPrefix = normalizedPath.slice(0, -2); // Remove /*

    handlers.push({
      handler: 'rewrite',
      strip_path_prefix: stripPrefix,
    });
  }

  // Normalize upstream for Incus DNS resolution
  const normalizedUpstream = normalizeUpstream(data.upstream);

  // Add reverse proxy handler
  handlers.push({
    handler: 'reverse_proxy',
    upstreams: [
      {
        dial: `${normalizedUpstream}:${data.port}`,
      },
    ],
  });

  const route: CaddyRoute = {
    '@id': generateRouteId(),
    handle: handlers,
  };

  // Add match conditions
  const match: { host?: string[]; path?: string[] } = {};
  
  if (data.hostname) {
    match.host = [data.hostname];
  }
  
  // Add path matcher (already normalized with /* suffix)
  if (!isRootPath) {
    match.path = [normalizedPath];
  }

  if (Object.keys(match).length > 0) {
    route.match = [match];
  }

  return { route, warning };
}

/**
 * Parse Caddy route to simplified ProxyRoute
 */
export function routeToProxyRoute(route: CaddyRoute): ProxyRoute | null {
  // Find the reverse_proxy handler (may not be first due to rewrite handler)
  const handler = route.handle?.find(h => h.handler === 'reverse_proxy');
  if (!handler || handler.handler !== 'reverse_proxy') return null;

  // Type assertion since we've verified handler type
  const proxyHandler = handler as { handler: 'reverse_proxy'; upstreams?: Array<{ dial: string }> };
  const upstream = proxyHandler.upstreams?.[0];
  if (!upstream?.dial) return null;

  // Parse dial address (e.g., "host:port" or "host.youeye:port")
  const [host, portStr] = upstream.dial.split(':');
  const port = parseInt(portStr, 10) || 80;

  // Strip container domain suffix for display (user enters container name, we add suffix internally)
  const domainSuffix = `.${CONTAINER_DOMAIN}`;
  const displayHost = host.endsWith(domainSuffix) ? host.slice(0, -domainSuffix.length)
    : host.endsWith('.incus') ? host.slice(0, -6) : host;

  // Clean up path for display (remove trailing /* or *)
  let path = route.match?.[0]?.path?.[0] || '/*';
  // Remove /* suffix (our new format)
  if (path.endsWith('/*')) {
    path = path.slice(0, -2);
  }
  // Remove single * suffix (legacy format)
  else if (path.endsWith('*')) {
    path = path.slice(0, -1);
  }
  // Ensure we show / for root paths
  if (path === '' || path === '/') {
    path = '/*';
  }

  return {
    id: route['@id'] || generateRouteId(),
    hostname: route.match?.[0]?.host?.[0],
    path,
    upstream: displayHost,
    port,
    enabled: true,
  };
}

/**
 * Get all proxy routes
 */
export async function getRoutes(): Promise<ProxyRoute[]> {
  const config = await getConfig();
  const routes: ProxyRoute[] = [];

  const servers = config.apps?.http?.servers || {};
  for (const server of Object.values(servers)) {
    for (const route of server.routes || []) {
      const proxyRoute = routeToProxyRoute(route);
      if (proxyRoute) {
        routes.push(proxyRoute);
      }
    }
  }

  return routes;
}

/**
 * Filter out default Caddy routes (file_server with no matchers)
 * These catch-all routes should be at the end, not before proxy routes
 */
function filterDefaultRoutes(routes: CaddyRoute[]): CaddyRoute[] {
  return routes.filter(route => {
    // Keep routes that have matchers (host/path)
    if (route.match && route.match.length > 0) {
      return true;
    }
    // Keep routes that are reverse_proxy (user-added)
    const handler = route.handle?.[0];
    if (handler?.handler === 'reverse_proxy') {
      return true;
    }
    // Filter out catch-all file_server routes
    return false;
  });
}

/**
 * Check if a route with the same hostname and path already exists
 */
function findDuplicateRoute(routes: CaddyRoute[], hostname?: string, path?: string): CaddyRoute | undefined {
  return routes.find(route => {
    const routeHost = route.match?.[0]?.host?.[0];
    const routePath = route.match?.[0]?.path?.[0];
    
    // Normalize paths for comparison (remove trailing *)
    const normalizedRoutePath = routePath?.replace(/\*$/, '') || '/';
    const normalizedNewPath = (path || '/*').replace(/\*$/, '') || '/';
    
    // Compare hostname (both undefined = match all hosts)
    const hostnameMatch = routeHost === hostname || (!routeHost && !hostname);
    
    // Compare path
    const pathMatch = normalizedRoutePath === normalizedNewPath;
    
    return hostnameMatch && pathMatch;
  });
}

/**
 * Ensure server has proper HTTPS configuration
 * Fixes servers that were created with only HTTP listener
 * Also enables HTTP→HTTPS redirect via automatic_https
 */
function ensureHTTPSConfig(server: HTTPServer): void {
  // Ensure listen array exists before checking
  if (!server.listen) server.listen = [];

  // Only listen on :443 — Caddy auto-creates a redirect server on :80
  // If we explicitly listen on :80, Caddy serves routes there instead of redirecting
  const has443 = server.listen.some(l => l === ':443' || l.endsWith(':443'));
  
  if (!has443) {
    server.listen.unshift(':443');
  }
  
  // Remove :80 from listen array if present (breaks automatic HTTP→HTTPS redirect)
  server.listen = server.listen.filter(l => l !== ':80' && !l.endsWith(':80'));
  
  // Ensure tls_connection_policies exists (required for Caddy to enable HTTPS)
  if (!server.tls_connection_policies || server.tls_connection_policies.length === 0) {
    server.tls_connection_policies = [{}];
  }
  
  // Enable HTTP→HTTPS redirect (Caddy auto-creates redirect server on port 80)
  if (!server.automatic_https) {
    server.automatic_https = {};
  }
  server.automatic_https.disable_redirects = false;
}

/**
 * Ensure TLS automation includes hostname for certificate generation
 * Uses Caddy's internal CA for self-signed certificates (local LAN only)
 * 
 * If a wildcard cert (*.domain.com) already exists, individual subdomain
 * subjects are skipped to avoid redundant per-subdomain certificates.
 */
function ensureTLSSubject(config: CaddyConfig, hostname: string): void {
  // Skip IP addresses - Caddy's internal CA can't issue certs for IPs
  if (isIPAddress(hostname)) {
    console.log(`[Caddy] Skipping TLS subject for IP address: ${hostname}`);
    return;
  }
  
  // Skip localhost and local domains
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
    console.log(`[Caddy] Skipping TLS subject for local hostname: ${hostname}`);
    return;
  }
  
  if (!config.apps) config.apps = {};
  if (!config.apps.tls) config.apps.tls = {};
  if (!config.apps.tls.automation) config.apps.tls.automation = {};
  if (!config.apps.tls.automation.policies) {
    config.apps.tls.automation.policies = [];
  }
  
  // Find existing policy with internal issuer that has explicit subjects (not on_demand fallback).
  // The on_demand policy (without subjects) is a catch-all fallback for IP-based access
  // and must NOT have subjects added to it, as that would restrict its scope.
  let internalPolicy = config.apps.tls.automation.policies.find(
    p => p.issuers?.some(i => i.module === 'internal') && !p.on_demand
  );

  if (!internalPolicy) {
    internalPolicy = {
      subjects: [],
      issuers: [{ module: 'internal' }],
    };
    config.apps.tls.automation.policies.push(internalPolicy);
  }
  
  if (!internalPolicy.subjects) {
    internalPolicy.subjects = [];
  }
  
  // Check if a wildcard already covers this hostname
  // e.g., *.skibidi.wtf covers pi-hole.skibidi.wtf
  const parts = hostname.split('.');
  if (parts.length >= 3) {
    const wildcardDomain = `*.${parts.slice(1).join('.')}`;
    if (internalPolicy.subjects.includes(wildcardDomain)) {
      console.log(`[Caddy] Skipping TLS subject ${hostname} - covered by wildcard ${wildcardDomain}`);
      return;
    }
  }
  
  // Add hostname to subjects if not already present
  if (!internalPolicy.subjects.includes(hostname)) {
    console.log(`[Caddy] Adding TLS subject: ${hostname}`);
    internalPolicy.subjects.push(hostname);
  }
}

/**
 * Sort routes for proper Caddy matching order:
 * 1. More specific paths first (longer paths)
 * 2. Routes with hostnames before catch-all
 * 3. Routes with paths before root paths
 */
function sortRoutes(routes: CaddyRoute[]): CaddyRoute[] {
  return [...routes].sort((a, b) => {
    const aPath = a.match?.[0]?.path?.[0] || '/*';
    const bPath = b.match?.[0]?.path?.[0] || '/*';
    const aHost = a.match?.[0]?.host?.[0];
    const bHost = b.match?.[0]?.host?.[0];
    
    // Routes with host matchers come before catch-all
    if (aHost && !bHost) return -1;
    if (!aHost && bHost) return 1;
    
    // Longer paths (more specific) come first
    const aLen = aPath.replace(/\*$/, '').length;
    const bLen = bPath.replace(/\*$/, '').length;
    if (aLen !== bLen) return bLen - aLen;
    
    // Non-wildcard paths before wildcard paths
    if (!aPath.includes('*') && bPath.includes('*')) return -1;
    if (aPath.includes('*') && !bPath.includes('*')) return 1;
    
    return 0;
  });
}

/**
 * Add a new route
 * Routes are sorted by specificity for proper Caddy matching
 * Returns the created route and optional warning message
 */
export async function addRoute(data: RouteFormData): Promise<{ route: ProxyRoute; warning?: string }> {
  console.log(`[Caddy] Adding route: ${data.hostname || '*'}${data.path || '/*'} -> ${data.upstream}:${data.port}`);
  
  const config = await getConfig();

  // Ensure server structure exists
  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};
  
  if (!config.apps.http.servers.srv0) {
    console.log('[Caddy] Creating new server srv0');
    config.apps.http.servers.srv0 = {
      listen: [':443'],
      routes: [],
      tls_connection_policies: [{}],
    };
  }
  
  // Ensure server has HTTPS properly configured (fix existing servers)
  ensureHTTPSConfig(config.apps.http.servers.srv0);
  
  // If hostname provided, ensure TLS automation includes it
  if (data.hostname) {
    ensureTLSSubject(config, data.hostname);
  }

  // Filter out default file_server routes that would catch all requests
  const existingRoutes = filterDefaultRoutes(config.apps.http.servers.srv0.routes || []);
  
  // Check for duplicate route (same hostname + path)
  const { normalized: normalizedPath } = normalizePathPattern(data.path);
  const duplicate = findDuplicateRoute(existingRoutes, data.hostname, normalizedPath);
  if (duplicate) {
    throw new Error(`A route for ${data.hostname || '*'}${normalizedPath} already exists`);
  }
  
  const { route, warning } = formDataToRoute(data);
  
  if (warning) {
    console.log(`[Caddy] ${warning}`);
  }
  
  // Add new route and sort all routes by specificity
  const allRoutes = [route, ...existingRoutes];
  config.apps.http.servers.srv0.routes = sortRoutes(allRoutes);
  
  console.log(`[Caddy] Total routes after add: ${config.apps.http.servers.srv0.routes.length}`);

  // Apply configuration atomically via /load endpoint
  await setConfig(config);
  
  // Verify the route was applied
  const verifyConfig = await getConfig();
  const appliedRoutes = verifyConfig.apps?.http?.servers?.srv0?.routes || [];
  const routeApplied = appliedRoutes.some(r => r['@id'] === route['@id']);
  
  if (!routeApplied) {
    throw new Error('Route was not applied - configuration may have been rejected');
  }
  
  console.log(`[Caddy] Route ${route['@id']} applied successfully`);

  return { route: routeToProxyRoute(route)!, warning };
}

/**
 * Remove a route by ID
 */
export async function removeRoute(id: string): Promise<void> {
  const config = await getConfig();

  const servers = config.apps?.http?.servers || {};
  for (const server of Object.values(servers)) {
    server.routes = (server.routes || []).filter(r => r['@id'] !== id);
  }

  await setConfig(config);
}

/**
 * Remove any route whose host matcher exactly equals the given IP literal.
 *
 * Used by the host-IP-change migration: legacy installs (created by Spine
 * <= 0.2.18.2) had a `${hostIP}:443 { tls internal ... }` block in their
 * Caddyfile, which compiled into a route with `match[0].host === [oldIP]`.
 * After a host IP change, that route becomes a dead match. We delete it
 * rather than rewriting it because the `:443` catch-all (on-demand TLS)
 * already serves CP from any IP.
 *
 * Idempotent — returns true if at least one route was removed, false if
 * no matching route was found.
 */
export async function removeIPLiteralRoute(ip: string): Promise<boolean> {
  if (!ip) return false;
  const config = await getConfig();

  let removed = false;
  const servers = config.apps?.http?.servers || {};
  for (const server of Object.values(servers)) {
    const before = (server.routes || []).length;
    server.routes = (server.routes || []).filter(r => {
      const matches = r.match || [];
      for (const m of matches) {
        const hosts = (m as { host?: string[] }).host || [];
        if (hosts.length === 1 && hosts[0] === ip) {
          return false;
        }
      }
      return true;
    });
    if ((server.routes || []).length !== before) {
      removed = true;
    }
  }

  if (removed) {
    await setConfig(config);
  }
  return removed;
}

/**
 * Update a route by ID
 */
export async function updateRoute(id: string, data: RouteFormData): Promise<{ route: ProxyRoute; warning?: string }> {
  await removeRoute(id);
  return addRoute(data);
}

/**
 * Generate initial configuration with internal TLS (self-signed certificates)
 * This creates a minimal working Caddy config ready for proxy routes.
 * Only listens on :443 — Caddy auto-creates HTTP→HTTPS redirect on :80.
 */
export function generateInitialConfig(hosts: string[]): CaddyConfig {
  // Filter out invalid hosts (IPs and local domains get self-signed anyway)
  const validHosts = hosts.filter(h => !isIPAddress(h) && h !== 'localhost');

  return {
    admin: {
      listen: '0.0.0.0:2019',
      enforce_origin: false,
    },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443'],
            routes: [],
            tls_connection_policies: [{}],
            // Automatic HTTPS settings
            automatic_https: {
              disable_redirects: false, // Enable HTTP->HTTPS redirects
            },
          },
        },
      },
      tls: {
        automation: {
          policies: validHosts.length > 0 ? [
            {
              subjects: validHosts,
              issuers: [{ module: 'internal' }],
            },
          ] : [],
        },
      },
    },
  };
}

/**
 * Update TLS configuration
 */
export async function updateTLS(hosts: string[]): Promise<void> {
  const config = await getConfig();

  if (!config.apps) config.apps = {};
  if (!config.apps.tls) config.apps.tls = {};
  if (!config.apps.tls.automation) config.apps.tls.automation = {};

  config.apps.tls.automation.policies = [
    {
      subjects: hosts,
      issuers: [{ module: 'internal' }],
    },
  ];

  await setConfig(config);
}

/**
 * Check Caddy health
 */
export async function checkHealth(): Promise<boolean> {
  try {
    await caddyRequest('GET', '/config/');
    return true;
  } catch {
    return false;
  }
}

/**
 * Route type for container routing
 */
export type RouteType = 'subdomain' | 'path' | 'none';

/**
 * Set up routing for a container with either subdomain or path routing
 * 
 * For path routing, this creates multiple routes:
 * 1. Main path route (e.g., /control/* -> app with path stripping)
 * 2. Static assets route (/_next/* -> app without stripping) for Next.js apps
 * 3. API route (/api/* -> app without stripping) if it's the primary app
 * 
 * @param domain - Base domain (e.g., skibidi.wtf)
 * @param containerName - Container name (e.g., youeye-control)
 * @param containerPort - Port inside the container
 * @param routeType - 'subdomain', 'path', or 'none'
 * @param routeValue - Subdomain prefix (e.g., 'control') or path (e.g., '/control')
 */
export async function setContainerRoute(
  domain: string,
  containerName: string,
  containerPort: number,
  routeType: RouteType,
  routeValue: string
): Promise<{ success: boolean; warning?: string; error?: string }> {
  try {
    // First, remove any existing routes for this container
    // BUT preserve the default catch-all route (it also points to CP)
    const existingRoutes = await getRoutes();
    for (const route of existingRoutes) {
      if (route.id === 'default-catchall') continue; // preserve setup catch-all
      if (route.upstream === containerName || route.upstream === `${containerName}.${CONTAINER_DOMAIN}` || route.upstream === `${containerName}.incus`) {
        await removeRoute(route.id);
      }
    }
    
    if (routeType === 'none') {
      return { success: true };
    }
    
    let warnings: string[] = [];
    
    if (routeType === 'subdomain') {
      // Subdomain routing: control.skibidi.wtf -> container:port
      const hostname = routeValue ? `${routeValue}.${domain}` : domain;
      const result = await addRoute({
        hostname,
        path: '/*',
        upstream: containerName,
        port: containerPort,
      });
      if (result.warning) warnings.push(result.warning);
    } else {
      // Path routing: skibidi.wtf/control/* -> container:port
      // This is complex because Next.js apps reference /_next/* with absolute paths
      
      const basePath = routeValue.startsWith('/') ? routeValue : `/${routeValue}`;
      
      // Main app route (with path stripping)
      const mainResult = await addRoute({
        hostname: domain,
        path: basePath,
        upstream: containerName,
        port: containerPort,
      });
      if (mainResult.warning) warnings.push(mainResult.warning);
      
      // For Next.js apps, also add routes for static assets
      // These don't strip the path prefix since Next.js expects /_next/* to be at root
      
      // /_next/* route (static assets - no stripping needed)
      await addRouteWithoutStripping(domain, '/_next/*', containerName, containerPort);
      
      // /favicon.ico route
      await addRouteWithoutStripping(domain, '/favicon.ico', containerName, containerPort);
      
      warnings.push(`Path routing requires DNS and TLS configured for ${domain}. Static assets (/_next/*) also routed.`);
    }
    
    return { 
      success: true, 
      warning: warnings.length > 0 ? warnings.join(' ') : undefined,
    };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Add a route without path stripping (for static assets).
 * Uses setConfig() to ensure admin API settings are preserved correctly.
 */
async function addRouteWithoutStripping(
  hostname: string,
  path: string,
  containerName: string,
  port: number
): Promise<void> {
  const config = await getConfig();

  // Ensure server structure exists
  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};

  const serverName = Object.keys(config.apps.http.servers)[0] || 'srv0';

  if (!config.apps.http.servers[serverName]) {
    config.apps.http.servers[serverName] = {
      listen: [':443'],
      routes: [],
      tls_connection_policies: [{}],
    };
  }

  // Ensure HTTPS is properly configured
  ensureHTTPSConfig(config.apps.http.servers[serverName]);

  const routes = config.apps.http.servers[serverName].routes || [];

  // Check if this exact route already exists
  const exists = routes.some((r: CaddyRoute) => {
    const match = r.match?.[0];
    return match?.host?.includes(hostname) && match?.path?.includes(path);
  });

  if (exists) return;

  const routeId = `route-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  const newRoute: CaddyRoute = {
    '@id': routeId,
    match: [{
      host: [hostname],
      path: [path],
    }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `${normalizeUpstream(containerName)}:${port}` }],
    }],
  };

  // Add at beginning (before catch-all routes)
  routes.unshift(newRoute);
  config.apps.http.servers[serverName].routes = routes;

  // Use setConfig() to ensure admin API settings are preserved
  await setConfig(config);
}

/**
 * Get the configured domain from Caddy's TLS automation
 * Returns the first non-wildcard domain found, or undefined
 */
export async function getConfiguredDomain(): Promise<string | undefined> {
  try {
    const config = await getConfig();
    const policies = config.apps?.tls?.automation?.policies || [];
    
    for (const policy of policies) {
      if (policy.subjects) {
        for (const subject of policy.subjects) {
          // Skip wildcards and return the first real domain
          if (!subject.startsWith('*') && subject.includes('.')) {
            // Extract base domain (remove subdomain if present)
            const parts = subject.split('.');
            if (parts.length >= 2) {
              // Return the last two parts (e.g., skibidi.wtf from control.skibidi.wtf)
              return parts.slice(-2).join('.');
            }
            return subject;
          }
        }
      }
    }
    
    // Try to extract from existing routes
    const routes = await getRoutes();
    for (const route of routes) {
      if (route.hostname && route.hostname.includes('.')) {
        const parts = route.hostname.split('.');
        if (parts.length >= 2) {
          return parts.slice(-2).join('.');
        }
      }
    }
    
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Set a default catch-all route (no host matcher).
 * This route matches any request not caught by host-specific routes (e.g., IP-based access).
 * Used to proxy IP-based access to the Control Panel for setup flow.
 */
export async function setDefaultRoute(containerName: string, port: number): Promise<void> {
  console.log(`[Caddy] Setting default catch-all route -> ${containerName}:${port}`);
  const config = await getConfig();

  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};

  if (!config.apps.http.servers.srv0) {
    config.apps.http.servers.srv0 = {
      listen: [':443'],
      routes: [],
      tls_connection_policies: [{}],
    };
  }

  ensureHTTPSConfig(config.apps.http.servers.srv0);

  const routes = config.apps.http.servers.srv0.routes || [];

  // Remove any existing default (host-less) catch-all routes
  // This includes Caddy's built-in file_server and any prior reverse_proxy catch-alls
  const filtered = routes.filter(r => {
    const hasHost = r.match?.[0]?.host && r.match[0].host.length > 0;
    if (!hasHost) {
      const isProxy = r.handle?.some(h => h.handler === 'reverse_proxy');
      const isFileServer = r.handle?.some(h => h.handler === 'file_server');
      if (isProxy || isFileServer) return false;
    }
    return true;
  });

  // Create new default route (no host matcher = catches everything)
  const defaultRoute: CaddyRoute = {
    '@id': 'default-catchall',
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `${normalizeUpstream(containerName)}:${port}` }],
    }],
    // No match = catches all requests not matched by other routes
  };

  // Append at end (lowest priority)
  filtered.push(defaultRoute);
  config.apps.http.servers.srv0.routes = sortRoutes(filtered);

  // Ensure TLS automation has on-demand internal CA policy.
  // This allows Caddy to serve a self-signed cert for IP addresses
  // (on_demand issues certs dynamically for any incoming TLS connection).
  // Explicitly check for on_demand policy instead of just checking array length,
  // since other policies (with subjects) may exist from ensureTLSSubject/setDomain.
  if (!config.apps.tls) config.apps.tls = {};
  if (!config.apps.tls.automation) config.apps.tls.automation = {};
  if (!config.apps.tls.automation.policies) {
    config.apps.tls.automation.policies = [];
  }

  const hasOnDemandPolicy = config.apps.tls.automation.policies.some(
    p => p.on_demand === true && !p.subjects?.length
  );
  if (!hasOnDemandPolicy) {
    console.log('[Caddy] Adding on_demand TLS fallback policy');
    config.apps.tls.automation.policies.push({
      on_demand: true,
      issuers: [{ module: 'internal' }],
    });
  }

  // Ensure on_demand TLS permission is set (required by Caddy v2.7+)
  // Uses CP's setup config endpoint as the "ask" URL — always returns 200
  if (!config.apps.tls.automation.on_demand) {
    config.apps.tls.automation.on_demand = {
      permission: {
        module: 'http',
        endpoint: `http://${normalizeUpstream(containerName)}:${port}/api/setup/config`,
      },
    };
  }

  await setConfig(config);
  console.log(`[Caddy] Default catch-all route set -> ${containerName}.${CONTAINER_DOMAIN}:${port}`);
}

/**
 * BUG-022: Ensure a /api/ping route exists that proxies to the Control Panel.
 *
 * When the root domain (e.g. johnvm.test) is routed to YE-UI, requests to
 * /api/ping go to UI (which returns 401) instead of CP. This route has no
 * host matcher and matches /api/ping on ALL hosts, forwarding to CP so Spine's
 * post-update health check works regardless of which domain is used.
 *
 * The route must be placed BEFORE host-matched routes in the sort order,
 * which sortRoutes() handles automatically because /api/ping/* is more specific
 * than /*.
 */
export async function ensurePingRoute(containerName: string = 'youeye-control', port: number = 3000): Promise<void> {
  const config = await getConfig();

  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};

  const serverName = Object.keys(config.apps.http.servers)[0] || 'srv0';
  if (!config.apps.http.servers[serverName]) {
    config.apps.http.servers[serverName] = {
      listen: [':443'],
      routes: [],
      tls_connection_policies: [{}],
    };
  }

  const routes = config.apps.http.servers[serverName].routes || [];

  // Remove any existing ping route
  const filtered = routes.filter(r => r['@id'] !== 'api-ping-route');

  // Create the /api/ping route (no host matcher = matches all hosts).
  // CRITICAL: This route must be FIRST in the array so it's evaluated BEFORE
  // host-matched routes. Otherwise, the root domain route (e.g. johnvm.test -> UI)
  // matches first and the request goes to the UI app which returns 401.
  const pingRoute: CaddyRoute = {
    '@id': 'api-ping-route',
    match: [{ path: ['/api/ping'] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `${normalizeUpstream(containerName)}:${port}` }],
    }],
  };

  // Insert at the BEGINNING, not at the end.
  // Do NOT use sortRoutes() here because it would push this host-less route
  // after host-matched routes, defeating the purpose.
  filtered.unshift(pingRoute);
  config.apps.http.servers[serverName].routes = filtered;

  await setConfig(config);
  console.log(`[Caddy] /api/ping route ensured at position 0 -> youeye-control.${CONTAINER_DOMAIN}:3000`);
}

/**
 * Set the base domain for routing
 * Configures TLS automation AND ensures HTTPS is properly configured on the server.
 *
 * This is critical: if the Caddy container was restarted and lost its autosave config,
 * it reverts to the default Caddyfile (:80 file_server only). setDomain must fix the
 * server config (add :443, remove :80, add TLS policies) so that subsequent addRoute
 * calls work correctly and HTTPS is functional.
 */
export async function setDomain(domain: string): Promise<void> {
  const config = await getConfig();

  // Ensure config structure
  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};
  if (!config.apps.tls) config.apps.tls = {};
  if (!config.apps.tls.automation) config.apps.tls.automation = {};

  // Ensure srv0 exists and has proper HTTPS configuration.
  // If Caddy reverted to default Caddyfile (e.g., container restart without persistent /config),
  // srv0 might only listen on :80. ensureHTTPSConfig fixes this by adding :443, removing :80,
  // and adding tls_connection_policies.
  if (!config.apps.http.servers.srv0) {
    config.apps.http.servers.srv0 = {
      listen: [':443'],
      routes: [],
      tls_connection_policies: [{}],
    };
  }
  ensureHTTPSConfig(config.apps.http.servers.srv0);

  // Build clean subject list: base domain + wildcard only
  // Individual subdomain subjects are redundant when wildcard exists
  const wildcard = `*.${domain}`;
  const cleanSubjects = new Set<string>();
  cleanSubjects.add(domain);
  cleanSubjects.add(wildcard);

  // Preserve any subjects from OTHER domains (not covered by this wildcard)
  for (const policy of config.apps.tls.automation.policies || []) {
    if (policy.subjects) {
      for (const subject of policy.subjects) {
        // Keep if it's a different domain entirely
        if (!subject.endsWith(`.${domain}`) && subject !== domain && subject !== wildcard) {
          cleanSubjects.add(subject);
        }
      }
    }
  }

  // Update TLS config with internal issuer (self-signed for local LAN)
  // Keep on-demand fallback policy for IP-based TLS (setup/done pages)
  config.apps.tls.automation.policies = [
    {
      subjects: Array.from(cleanSubjects),
      issuers: [{ module: 'internal' }],
    },
    {
      on_demand: true,
      issuers: [{ module: 'internal' }],
    },
  ];

  // Ensure on_demand TLS permission is set (required by Caddy v2.7+)
  if (!config.apps.tls.automation.on_demand) {
    config.apps.tls.automation.on_demand = {
      permission: {
        module: 'http',
        endpoint: `http://youeye-control.${CONTAINER_DOMAIN}:3000/api/setup/config`,
      },
    };
  }

  await setConfig(config);
}

// ─── Forward-Auth Toggle ─────────────────────────────────

/**
 * Add forward_auth handler to an existing route (by hostname).
 */
export async function addForwardAuthToRoute(
  hostname: string,
  forwardAuthConfig: { uri: string; copyHeaders: string[] }
): Promise<void> {
  const config = await getConfig();
  if (!config?.apps?.http?.servers) return;

  let modified = false;
  for (const server of Object.values(config.apps.http.servers)) {
    for (const route of server.routes || []) {
      const hosts = (route as any).match?.[0]?.host || [];
      if (hosts.includes(hostname)) {
        // Remove any existing forward_auth handler
        route.handle = route.handle.filter((h: any) => h.handler !== 'forward_auth');
        // Prepend new one
        route.handle.unshift({
          handler: 'forward_auth',
          uri: forwardAuthConfig.uri,
          copy_headers: forwardAuthConfig.copyHeaders,
          trust_forwarded_headers: true,
        });
        modified = true;
      }
    }
  }

  if (modified) {
    await setConfig(config);
  }
}

/**
 * Remove forward_auth handler from an existing route (by hostname).
 */
export async function removeForwardAuthFromRoute(hostname: string): Promise<void> {
  const config = await getConfig();
  if (!config?.apps?.http?.servers) return;

  let modified = false;
  for (const server of Object.values(config.apps.http.servers)) {
    for (const route of server.routes || []) {
      const hosts = (route as any).match?.[0]?.host || [];
      if (hosts.includes(hostname)) {
        const before = route.handle.length;
        route.handle = route.handle.filter((h: any) => h.handler !== 'forward_auth');
        if (route.handle.length !== before) modified = true;
      }
    }
  }

  if (modified) {
    await setConfig(config);
  }
}

// ─── Multi-Entrance Routing ──────────────────────────────

export interface EntranceConfig {
  name: string;
  path: string;
  port: number;
  container?: string;
  protocol?: 'http' | 'tcp';
  authLevel?: 'private' | 'public' | 'internal' | 'none';
  stripPath?: boolean;
}

/**
 * Add multiple routes for an app with multiple entrances.
 */
export async function addAppRoutes(
  appId: string,
  hostname: string,
  entrances: EntranceConfig[],
  primaryContainer: string,
  forwardAuthConfig?: { uri: string; copyHeaders: string[] }
): Promise<void> {
  for (const entrance of entrances) {
    if (entrance.protocol === 'tcp') continue;
    if (entrance.authLevel === 'internal') continue;

    const containerName = entrance.container
      ? `app-${appId}-${entrance.container}`
      : primaryContainer;
    const normalizedUpstream = normalizeUpstream(containerName);

    const handlers: any[] = [];

    // Add forward-auth for private entrances
    if (entrance.authLevel === 'private' && forwardAuthConfig) {
      handlers.push({
        handler: 'forward_auth',
        uri: forwardAuthConfig.uri,
        copy_headers: forwardAuthConfig.copyHeaders,
        trust_forwarded_headers: true,
      });
    }

    // Path stripping
    if (entrance.stripPath && entrance.path !== '/') {
      handlers.push({
        handler: 'rewrite',
        strip_path_prefix: entrance.path,
      });
    }

    // Reverse proxy
    handlers.push({
      handler: 'reverse_proxy',
      upstreams: [{ dial: `${normalizedUpstream}:${entrance.port}` }],
    });

    const match: { host?: string[]; path?: string[] } = { host: [hostname] };
    if (entrance.path !== '/') {
      match.path = [`${entrance.path}/*`];
    }

    try {
      const cfg = await getConfig();
      if (!cfg?.apps?.http?.servers) continue;
      const serverName = Object.keys(cfg.apps.http.servers)[0];
      const server = cfg.apps.http.servers[serverName];
      server.routes = server.routes || [];

      // Remove existing route with same ID if present
      const routeId = `app-${appId}-${entrance.name}`;
      server.routes = server.routes.filter((r: any) => r['@id'] !== routeId);
      server.routes.push({
        '@id': routeId,
        match: [match],
        handle: handlers,
        terminal: true,
      });
      await setConfig(cfg);
    } catch (err) {
      console.error(`[caddy] Failed to add entrance route ${entrance.name}:`, err);
    }
  }
}

/**
 * Remove all routes for an app (by ID prefix).
 */
export async function removeAppRoutes(appId: string): Promise<void> {
  const cfg = await getConfig();
  if (!cfg?.apps?.http?.servers) return;

  let modified = false;
  for (const server of Object.values(cfg.apps.http.servers)) {
    const before = (server.routes || []).length;
    server.routes = (server.routes || []).filter(
      (r: any) => !r['@id']?.startsWith(`app-${appId}-`)
    );
    if ((server.routes || []).length !== before) modified = true;
  }

  if (modified) {
    await setConfig(cfg);
  }
}
