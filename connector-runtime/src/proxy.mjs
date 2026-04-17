/**
 * Connector proxy handler — receives requests from YE-UI, fetches upstream,
 * applies transforms, returns normalized data.
 *
 * Request body:
 * {
 *   connectorId: string,
 *   endpoint: string,
 *   params: Record<string, string|number|boolean>,
 *   lang?: string,
 *   userConfig?: Record<string, string>,  // decrypted credentials from YE-UI
 *   manifest: object                       // full connector manifest (YE-UI caches and forwards)
 * }
 */

import { applyJsonMap } from './transforms/json-map.mjs';
import { executeScriptTransform } from './transforms/script.mjs';
import { checkSSRF, checkResolvedIP } from './security/ssrf.mjs';
import { checkRateLimit } from './security/rate-limit.mjs';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

function substituteTemplate(template, context) {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    let defaultValue;
    let path = expr;
    const pipeIdx = expr.indexOf('|default:');
    if (pipeIdx !== -1) {
      defaultValue = expr.slice(pipeIdx + 9);
      path = expr.slice(0, pipeIdx);
    }

    const parts = path.split('.');
    const namespace = parts[0];
    const key = parts.slice(1).join('.');

    let value;
    if (namespace === 'query' || namespace === 'param') {
      const v = context.query[key];
      value = v !== undefined ? String(v) : undefined;
    } else if (namespace === 'config') {
      value = context.config[key];
    } else if (namespace === 'lang' || path === 'lang') {
      value = context.lang ?? 'en';
    } else {
      const v = context.query[path];
      value = v !== undefined ? String(v) : undefined;
    }

    return value ?? defaultValue ?? '';
  });
}

export async function handleProxy(req, res, body, sendJSON) {
  const { connectorId, endpoint: endpointName, params = {}, lang, userConfig = {}, manifest } = body;

  if (!connectorId || !endpointName || !manifest) {
    return sendJSON(res, 400, { ok: false, error: 'Missing connectorId, endpoint, or manifest', code: 'BAD_REQUEST' });
  }

  // Rate limiting by app token
  const appToken = req.headers['x-youeye-app'] || connectorId;
  const rateCheck = checkRateLimit(appToken);
  if (!rateCheck.allowed) {
    res.setHeader('Retry-After', Math.ceil(rateCheck.resetMs / 1000));
    return sendJSON(res, 429, { ok: false, error: 'Rate limit exceeded', code: 'RATE_LIMITED', retryAfter: rateCheck.resetMs });
  }

  // Find endpoint in manifest
  const endpoints = manifest.api?.endpoints || {};
  const endpointDef = endpoints[endpointName];
  if (!endpointDef) {
    return sendJSON(res, 400, { ok: false, error: `Endpoint "${endpointName}" not found`, code: 'NO_ENDPOINT', connectorId });
  }

  // Build template context
  const context = { query: params, config: userConfig, lang };

  // Build upstream URL
  let url = substituteTemplate(endpointDef.url, context);
  if (endpointDef.method === 'GET' && endpointDef.params) {
    const sp = new URLSearchParams();
    for (const [key, template] of Object.entries(endpointDef.params)) {
      const value = substituteTemplate(template, context);
      if (value) sp.set(key, value);
    }
    const qs = sp.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  // SSRF check
  const networkMode = manifest.metadata?.network || 'internet';
  const allowedHosts = manifest.permissions?.network?.allowedHosts || [];
  const ssrfCheck = checkSSRF(url, networkMode, allowedHosts);
  if (!ssrfCheck.safe) {
    return sendJSON(res, 403, { ok: false, error: `Blocked: ${ssrfCheck.reason}`, code: 'NETWORK_BLOCKED', connectorId });
  }

  // DNS rebinding check
  try {
    const hostname = new URL(url).hostname;
    const dnsCheck = await checkResolvedIP(hostname);
    if (!dnsCheck.safe) {
      return sendJSON(res, 403, { ok: false, error: `Blocked: ${dnsCheck.reason}`, code: 'NETWORK_BLOCKED', connectorId });
    }
  } catch { /* let fetch fail naturally */ }

  // Build headers
  const headers = {
    'User-Agent': 'YouEye-Connector-Runtime/1.0',
    'Accept': 'application/json',
  };

  const auth = manifest.permissions?.auth;
  if (auth && auth.method !== 'none' && auth.header && auth.value) {
    headers[auth.header] = substituteTemplate(auth.value, context);
  }

  if (endpointDef.headers) {
    for (const [key, template] of Object.entries(endpointDef.headers)) {
      headers[key] = substituteTemplate(template, context);
    }
  }

  // Execute upstream request
  try {
    const fetchOptions = {
      method: endpointDef.method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };

    if ((endpointDef.method === 'POST' || endpointDef.method === 'PUT') && endpointDef.params) {
      const reqBody = {};
      for (const [key, template] of Object.entries(endpointDef.params)) {
        reqBody[key] = substituteTemplate(template, context);
      }
      fetchOptions.body = JSON.stringify(reqBody);
      headers['Content-Type'] = 'application/json';
    }

    const upstream = await fetch(url, fetchOptions);

    // Check response size via Content-Length header
    const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return sendJSON(res, 502, { ok: false, error: `Response too large: ${contentLength} bytes`, code: 'UPSTREAM_ERROR', connectorId });
    }

    if (!upstream.ok) {
      return sendJSON(res, upstream.status, {
        ok: false,
        error: `Upstream API error: ${upstream.status} ${upstream.statusText}`,
        code: 'UPSTREAM_ERROR',
        connectorId,
      });
    }

    // Read body with size limit
    const chunks = [];
    let totalSize = 0;
    const reader = upstream.body?.getReader();
    if (!reader) {
      return sendJSON(res, 502, { ok: false, error: 'No response body', code: 'UPSTREAM_ERROR', connectorId });
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_RESPONSE_BYTES) {
        reader.cancel();
        return sendJSON(res, 502, { ok: false, error: 'Response exceeded 10 MB limit', code: 'UPSTREAM_ERROR', connectorId });
      }
      chunks.push(value);
    }

    const rawText = Buffer.concat(chunks).toString();
    let rawData;
    try { rawData = JSON.parse(rawText); } catch {
      return sendJSON(res, 502, { ok: false, error: 'Upstream returned non-JSON response', code: 'UPSTREAM_ERROR', connectorId });
    }

    // Apply transform
    const transform = endpointDef.responseTransform;
    let transformed;

    if (!transform || transform.type === 'passthrough') {
      transformed = rawData;
    } else if (transform.type === 'json-map') {
      transformed = applyJsonMap(rawData, transform);
    } else if (transform.type === 'script') {
      if (!transform.code) {
        return sendJSON(res, 400, { ok: false, error: 'Script transform missing code', code: 'TRANSFORM_ERROR', connectorId });
      }
      try {
        transformed = await executeScriptTransform(transform.code, rawData);
      } catch (err) {
        const msg = err.message || String(err);
        const code = msg.includes('timed out') ? 'TRANSFORM_TIMEOUT'
          : msg.includes('memory') ? 'TRANSFORM_OOM'
          : 'TRANSFORM_ERROR';
        return sendJSON(res, 500, { ok: false, error: `Script transform failed: ${msg}`, code, connectorId });
      }
    } else {
      transformed = rawData;
    }

    return sendJSON(res, 200, { ok: true, status: 200, data: transformed, connectorId, cached: false });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return sendJSON(res, 504, { ok: false, error: 'Upstream API timeout', code: 'UPSTREAM_ERROR', connectorId });
    }
    return sendJSON(res, 502, {
      ok: false,
      error: `Upstream fetch failed: ${err.message || String(err)}`,
      code: 'UPSTREAM_ERROR',
      connectorId,
    });
  }
}
