/**
 * Connector proxy — executes upstream API calls on behalf of native apps.
 *
 * Responsibilities:
 * 1. Resolve the connector manifest
 * 2. Validate the requested endpoint exists
 * 3. Enforce network policy (allowedHosts)
 * 4. Substitute template variables in URL/params
 * 5. Attach auth credentials
 * 6. Execute the upstream request
 * 7. Apply response transforms
 * 8. Return normalized data
 */

import { fetchConnectorManifest } from './registry';
import type { ConnectorManifest, ConnectorEndpoint, ResponseTransform } from './schema';

export interface ProxyRequest {
  connectorId: string;
  endpoint: string;
  params: Record<string, string | number | boolean | undefined>;
  lang?: string;
  /** User-supplied connector config (API keys, etc.) — decrypted before passing here */
  userConfig?: Record<string, string>;
  /** Resolved base URL for connectors using ${baseUrl} template (auto-wired or user-provided) */
  baseUrl?: string;
}

export interface ProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
  connectorId: string;
  cached: boolean;
}

export interface ProxyError {
  ok: false;
  status: number;
  error: string;
  code: 'NO_CONNECTOR' | 'NO_ENDPOINT' | 'NETWORK_BLOCKED' | 'UPSTREAM_ERROR' | 'TRANSFORM_ERROR';
  connectorId?: string;
}

// ─── Template Substitution ─────────────────────────────────

/**
 * Replace ${...} expressions in a template string.
 * Supports: ${param.name}, ${config.key}, ${query.key|default:val}
 */
function substituteTemplate(
  template: string,
  context: {
    query: Record<string, string | number | boolean | undefined>;
    config: Record<string, string>;
    lang?: string;
    baseUrl?: string;
  }
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    // Handle default values: ${query.page|default:1}
    let defaultValue: string | undefined;
    let path = expr;
    const pipeIdx = expr.indexOf('|default:');
    if (pipeIdx !== -1) {
      defaultValue = expr.slice(pipeIdx + 9);
      path = expr.slice(0, pipeIdx);
    }

    const parts = path.split('.');
    const namespace = parts[0];
    const key = parts.slice(1).join('.');

    let value: string | undefined;

    if (path === 'baseUrl') {
      value = context.baseUrl;
    } else if (namespace === 'query' || namespace === 'param') {
      const v = context.query[key];
      value = v !== undefined ? String(v) : undefined;
    } else if (namespace === 'config') {
      value = context.config[key];
    } else if (namespace === 'lang' || path === 'lang') {
      value = context.lang ?? 'en';
    } else {
      // Fallback: treat as a query param name
      const v = context.query[path];
      value = v !== undefined ? String(v) : undefined;
    }

    return value ?? defaultValue ?? '';
  });
}

// ─── Network Policy ────────────────────────────────────────

function isHostAllowed(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true; // No restrictions

  try {
    const hostname = new URL(url).hostname;
    return allowedHosts.some((pattern) => {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // .wikipedia.org
        return hostname.endsWith(suffix) || hostname === pattern.slice(2);
      }
      return hostname === pattern;
    });
  } catch {
    return false;
  }
}

// ─── Response Transform ────────────────────────────────────

function applyTransform(data: unknown, transform?: ResponseTransform): unknown {
  if (!transform || transform.type === 'passthrough') return data;

  if (transform.type === 'json-map') {
    let root = data;

    // Navigate to root path (simple JSONPath: $.key.subkey or $.results)
    if (transform.root && transform.root !== '$') {
      const parts = transform.root.replace(/^\$\.?/, '').split('.');
      for (const part of parts) {
        if (root && typeof root === 'object' && part in root) {
          root = (root as Record<string, unknown>)[part];
        } else {
          return null;
        }
      }
    }

    // If no map, return the root directly
    if (!transform.map) return root;

    // If root is an array, map each element
    if (Array.isArray(root)) {
      return root.map((item) => mapObject(item, transform.map!));
    }

    // Otherwise map the single object
    return mapObject(root, transform.map);
  }

  return data;
}

function mapObject(obj: unknown, fieldMap: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [outputKey, pathExpr] of Object.entries(fieldMap)) {
    // Handle || fallback expressions: $.title || $.name
    const alternatives = pathExpr.split('||').map((s) => s.trim());
    let value: unknown;

    for (const alt of alternatives) {
      value = extractValue(obj, alt);
      if (value !== undefined && value !== null) break;
    }

    result[outputKey] = value ?? null;
  }

  return result;
}

function extractValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;

  // Strip leading $. if present
  const cleanPath = path.replace(/^\$\.?/, '');
  if (!cleanPath) return obj;

  // Handle array access: $.genres[*].name
  if (cleanPath.includes('[*]')) {
    const [arrayPath, rest] = cleanPath.split('[*].');
    const arr = extractValue(obj, arrayPath);
    if (Array.isArray(arr) && rest) {
      return arr.map((item) => extractValue(item, rest)).filter((v) => v !== undefined);
    }
    return arr;
  }

  // Simple dot navigation
  const parts = cleanPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

// ─── Proxy Execution ───────────────────────────────────────

/**
 * Execute a proxied request through a connector.
 */
export async function executeProxy(req: ProxyRequest): Promise<ProxyResult | ProxyError> {
  // 1. Fetch manifest
  let manifest: ConnectorManifest;
  try {
    manifest = await fetchConnectorManifest(req.connectorId);
  } catch {
    return { ok: false, status: 404, error: `Connector not found: ${req.connectorId}`, code: 'NO_CONNECTOR' };
  }

  // 2. Find endpoint
  const endpointDef = manifest.api.endpoints[req.endpoint];
  if (!endpointDef) {
    return {
      ok: false,
      status: 400,
      error: `Endpoint "${req.endpoint}" not found in connector "${req.connectorId}"`,
      code: 'NO_ENDPOINT',
      connectorId: req.connectorId,
    };
  }

  // 3. Build context for template substitution
  const context = {
    query: req.params,
    config: req.userConfig ?? {},
    lang: req.lang,
    baseUrl: req.baseUrl,
  };

  // 4. Build upstream URL
  let url = substituteTemplate(endpointDef.url, context);

  // For GET requests, add params as query string
  if (endpointDef.method === 'GET' && endpointDef.params) {
    const searchParams = new URLSearchParams();
    for (const [key, template] of Object.entries(endpointDef.params)) {
      const value = substituteTemplate(template, context);
      if (value) searchParams.set(key, value);
    }
    const qs = searchParams.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  // 5. Enforce network policy
  if (!isHostAllowed(url, manifest.permissions.network.allowedHosts)) {
    return {
      ok: false,
      status: 403,
      error: `Host blocked by network policy: ${new URL(url).hostname}`,
      code: 'NETWORK_BLOCKED',
      connectorId: req.connectorId,
    };
  }

  // 6. Build headers
  const headers: Record<string, string> = {
    'User-Agent': 'YouEye-Connector-Proxy/1.0',
    Accept: 'application/json',
  };

  // Add auth header if configured
  if (manifest.permissions.auth.method !== 'none' && manifest.permissions.auth.header && manifest.permissions.auth.value) {
    headers[manifest.permissions.auth.header] = substituteTemplate(manifest.permissions.auth.value, context);
  }

  // Add endpoint-specific headers
  if (endpointDef.headers) {
    for (const [key, template] of Object.entries(endpointDef.headers)) {
      headers[key] = substituteTemplate(template, context);
    }
  }

  // 7. Execute upstream request
  try {
    const fetchOptions: RequestInit = {
      method: endpointDef.method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };

    // For POST/PUT, send params as body
    if ((endpointDef.method === 'POST' || endpointDef.method === 'PUT') && endpointDef.params) {
      const body: Record<string, string> = {};
      for (const [key, template] of Object.entries(endpointDef.params)) {
        body[key] = substituteTemplate(template, context);
      }
      fetchOptions.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, fetchOptions);

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Upstream API error: ${res.status} ${res.statusText}`,
        code: 'UPSTREAM_ERROR',
        connectorId: req.connectorId,
      };
    }

    const rawData = await res.json();

    // 8. Apply response transform
    try {
      const transformed = applyTransform(rawData, endpointDef.responseTransform);
      return {
        ok: true,
        status: 200,
        data: transformed,
        connectorId: req.connectorId,
        cached: false,
      };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: `Transform error: ${err instanceof Error ? err.message : String(err)}`,
        code: 'TRANSFORM_ERROR',
        connectorId: req.connectorId,
      };
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        error: 'Upstream API timeout',
        code: 'UPSTREAM_ERROR',
        connectorId: req.connectorId,
      };
    }
    return {
      ok: false,
      status: 502,
      error: `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'UPSTREAM_ERROR',
      connectorId: req.connectorId,
    };
  }
}
