/**
 * Caddy API Types
 * 
 * Type definitions for Caddy's Admin API.
 * Reference: https://caddyserver.com/docs/api
 */

/**
 * Caddy route match condition
 */
export interface RouteMatch {
  host?: string[];
  path?: string[];
  method?: string[];
}

/**
 * Reverse proxy upstream
 */
export interface Upstream {
  dial: string; // e.g., "youeye-control.incus:3000"
}

/**
 * Reverse proxy handler
 */
export interface ReverseProxyHandler {
  handler: 'reverse_proxy';
  upstreams: Upstream[];
  headers?: {
    request?: {
      set?: Record<string, string[]>;
      add?: Record<string, string[]>;
      delete?: string[];
    };
  };
}

/**
 * Rewrite handler for path stripping
 */
export interface RewriteHandler {
  handler: 'rewrite';
  strip_path_prefix?: string;
  uri?: string;
}

/**
 * Static response handler
 */
export interface StaticResponseHandler {
  handler: 'static_response';
  status_code?: number;
  headers?: Record<string, string[]>;
  body?: string;
}

/**
 * Handler types
 */
export type RouteHandler = ReverseProxyHandler | RewriteHandler | StaticResponseHandler | { handler: string; [key: string]: unknown };

/**
 * Caddy route configuration
 */
export interface CaddyRoute {
  '@id'?: string;
  match?: RouteMatch[];
  handle: RouteHandler[];
  terminal?: boolean;
}

/**
 * TLS connection policy
 */
export interface TLSConnectionPolicy {
  match?: {
    sni?: string[];
  };
  certificate_selection?: {
    any_tag?: string[];
  };
}

/**
 * TLS automation policy
 */
export interface TLSAutomationPolicy {
  subjects?: string[];
  on_demand?: boolean;
  issuers?: Array<{
    module: string;
  }>;
}

/**
 * HTTP server configuration
 */
export interface HTTPServer {
  listen: string[];
  routes: CaddyRoute[];
  tls_connection_policies?: TLSConnectionPolicy[];
  automatic_https?: {
    disable?: boolean;
    disable_redirects?: boolean;
  };
}

/**
 * Caddy apps configuration
 */
export interface CaddyApps {
  http?: {
    servers?: Record<string, HTTPServer>;
  };
  tls?: {
    automation?: {
      policies?: TLSAutomationPolicy[];
      on_demand?: {
        permission?: {
          module: string;
          endpoint: string;
        };
      };
    };
    certificates?: {
      automate?: string[];
    };
  };
}

/**
 * Full Caddy configuration
 */
export interface CaddyConfig {
  admin?: {
    listen?: string;
    enforce_origin?: boolean;
    origins?: string[];
  };
  apps?: CaddyApps;
}

/**
 * Simplified route for UI
 */
export interface ProxyRoute {
  id: string;
  hostname?: string;
  path: string;
  upstream: string;
  port: number;
  enabled: boolean;
}

/**
 * Route form data for creating/editing routes
 */
export interface RouteFormData {
  hostname?: string;
  path: string;
  upstream: string;
  port: number;
}

/**
 * TLS configuration for UI
 */
export interface TLSConfig {
  mode: 'internal' | 'acme' | 'manual';
  domains: string[];
  ipAddresses: string[];
  email?: string; // For ACME
  issuer?: string;
}

/**
 * Certificate info
 */
export interface CertificateInfo {
  subjects: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  isInternal: boolean;
}

/**
 * Caddy status response
 */
export interface CaddyStatus {
  running: boolean;
  version?: string;
  uptime?: number;
  config?: CaddyConfig;
}
