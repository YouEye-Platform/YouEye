/**
 * YouEye Connector Runtime — server.mjs
 *
 * Stateless proxy that sits between YE-UI and upstream APIs.
 * YE-UI sends the full manifest + params + decrypted credentials;
 * the runtime builds the upstream request, fetches, transforms, and returns.
 *
 * Endpoints:
 *   GET  /health  — health check
 *   POST /proxy   — proxy a connector request to upstream
 *
 * Environment:
 *   PORT     — listen port (default 3001)
 *   HOSTNAME — bind address (default 0.0.0.0)
 */

import { createServer } from "node:http";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const PORT = parseInt(process.env.PORT || "3001", 10);
const BIND = process.env.HOSTNAME || "0.0.0.0";
const VERSION = "0.1.0";

// ─── SSRF Blocklist ──────────────────────────────────────────

const BLOCKED_RANGES_INTERNET = [
  /^127\./, /^0\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^fc00:/i, /^fd/i, /^fe80:/i,
  /^::1$/, /^localhost$/i, /^.*\.local$/i,
];

const BLOCKED_RANGES_LOCAL = [
  /^127\./, /^0\./, /^169\.254\./, /^::1$/,
];

function isHostBlocked(hostname, networkType) {
  const blocklist = networkType === "local" ? BLOCKED_RANGES_LOCAL : BLOCKED_RANGES_INTERNET;
  return blocklist.some((re) => re.test(hostname));
}

// ─── Template interpolation ──────────────────────────────────

function interpolate(template, params, userConfig, lang) {
  if (typeof template !== "string") return template;
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    // Handle ${query.X} references
    const queryMatch = expr.match(/^query\.(\w+)(?:\|default:(.*))?$/);
    if (queryMatch) {
      const [, key, defaultVal] = queryMatch;
      return params[key] ?? defaultVal ?? "";
    }
    // Handle ${config.X} for user credentials
    const configMatch = expr.match(/^config\.(\w+)$/);
    if (configMatch) {
      return userConfig[configMatch[1]] ?? "";
    }
    // Handle ${lang}
    if (expr === "lang") return lang || "en";
    return "";
  });
}

// ─── JSON-Map Transform ──────────────────────────────────────

function resolvePath(obj, path) {
  if (!path || !obj) return obj;
  // Remove leading $. notation
  const clean = path.replace(/^\$\./, "");
  const parts = clean.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function applyJsonMap(data, transform) {
  const { root, map } = transform;

  let items = root ? resolvePath(data, root) : data;

  if (!map) return items;

  if (Array.isArray(items)) {
    return items.map((item) => {
      const mapped = {};
      for (const [outKey, srcPath] of Object.entries(map)) {
        mapped[outKey] = resolvePath(item, srcPath);
      }
      return mapped;
    });
  }

  // Single object
  if (items && typeof items === "object") {
    const mapped = {};
    for (const [outKey, srcPath] of Object.entries(map)) {
      mapped[outKey] = resolvePath(items, srcPath);
    }
    return mapped;
  }

  return items;
}

// ─── Script Transform (sandboxed) ───────────────────────────

function applyScript(data, code) {
  const sandbox = { data, result: null };
  try {
    runInNewContext(`result = (function(data) { ${code} })(data)`, sandbox, {
      timeout: 1000,
      // 8 MB memory not directly settable in vm, but timeout prevents runaways
    });
    return sandbox.result ?? data;
  } catch (err) {
    return { __transformError: err.message, rawData: data };
  }
}

// ─── Apply response transform ────────────────────────────────

function applyTransform(data, transform) {
  if (!transform) return data;

  switch (transform.type) {
    case "passthrough":
      return data;
    case "json-map":
      return applyJsonMap(data, transform);
    case "script":
      if (!transform.code) return data;
      return applyScript(data, transform.code);
    default:
      return data;
  }
}

// ─── Build upstream request ──────────────────────────────────

function buildUpstreamRequest(manifest, endpointName, params, userConfig, lang) {
  const endpoints = manifest?.api?.endpoints;
  if (!endpoints || !endpoints[endpointName]) {
    return { error: `Endpoint "${endpointName}" not found in manifest` };
  }

  const ep = endpoints[endpointName];
  const networkType = manifest.permissions?.network?.type || manifest.metadata?.network || "internet";

  // Interpolate URL
  let url = interpolate(ep.url, params, userConfig, lang);

  // Build query params for GET
  const builtParams = {};
  if (ep.params) {
    for (const [key, template] of Object.entries(ep.params)) {
      const val = interpolate(template, params, userConfig, lang);
      if (val !== "") builtParams[key] = val;
    }
  }

  // Build headers
  const headers = { "User-Agent": "YouEye-Connector/1.0" };
  if (ep.headers) {
    for (const [key, template] of Object.entries(ep.headers)) {
      headers[key] = interpolate(template, params, userConfig, lang);
    }
  }

  // Inject auth credentials
  const auth = manifest.permissions?.auth;
  if (auth && auth.method !== "none" && userConfig) {
    if (auth.method === "bearer") {
      const token = userConfig.api_key || userConfig.token || userConfig.bearer_token || "";
      if (token) headers["Authorization"] = `Bearer ${token}`;
    } else if (auth.method === "api-key" && auth.header) {
      const key = userConfig.api_key || userConfig[auth.header.toLowerCase()] || "";
      if (key) headers[auth.header] = auth.value ? auth.value.replace("${config.api_key}", key) : key;
    } else if (auth.method === "basic") {
      const user = userConfig.username || "";
      const pass = userConfig.password || "";
      if (user) headers["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    }
  }

  // SSRF check on target host
  try {
    const parsedUrl = new URL(url);
    if (isHostBlocked(parsedUrl.hostname, networkType)) {
      return { error: `Blocked host: ${parsedUrl.hostname} (network: ${networkType})` };
    }
    // Append query params for GET
    if (ep.method === "GET" || !ep.method) {
      for (const [k, v] of Object.entries(builtParams)) {
        parsedUrl.searchParams.set(k, v);
      }
      url = parsedUrl.toString();
    }
  } catch {
    return { error: `Invalid URL: ${url}` };
  }

  return {
    url,
    method: ep.method || "GET",
    headers,
    body: ep.method === "POST" ? JSON.stringify(builtParams) : undefined,
    transform: ep.responseTransform || null,
    networkType,
  };
}

// ─── Request handler ─────────────────────────────────────────

async function handleProxy(body) {
  const { connectorId, endpoint, params = {}, lang, userConfig = {}, manifest } = body;

  if (!connectorId || !endpoint || !manifest) {
    return { status: 400, body: { ok: false, error: "Missing connectorId, endpoint, or manifest", code: "BAD_REQUEST" } };
  }

  const req = buildUpstreamRequest(manifest, endpoint, params, userConfig, lang);
  if (req.error) {
    const isBlocked = req.error.startsWith("Blocked host");
    return {
      status: isBlocked ? 403 : 400,
      body: { ok: false, error: req.error, code: isBlocked ? "NETWORK_BLOCKED" : "BAD_REQUEST" },
    };
  }

  try {
    const fetchOpts = {
      method: req.method,
      headers: req.headers,
      signal: AbortSignal.timeout(15_000),
    };
    if (req.body) fetchOpts.body = req.body;

    const upstream = await fetch(req.url, fetchOpts);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return {
        status: 502,
        body: {
          ok: false,
          error: `Upstream returned ${upstream.status}: ${errText.slice(0, 200)}`,
          code: "UPSTREAM_ERROR",
          upstreamStatus: upstream.status,
        },
      };
    }

    const contentType = upstream.headers.get("content-type") || "";
    let data;

    if (contentType.includes("application/json") || contentType.includes("text/json")) {
      data = await upstream.json();
    } else {
      // Try parsing as JSON anyway, fall back to text
      const text = await upstream.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    const transformed = applyTransform(data, req.transform);

    return {
      status: 200,
      body: { ok: true, data: transformed, cached: false },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("abort") || message.includes("timeout");
    return {
      status: isTimeout ? 504 : 502,
      body: {
        ok: false,
        error: `Upstream fetch failed: ${message}`,
        code: isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      },
    };
  }
}

// ─── HTTP Server ─────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${BIND}:${PORT}`);

  // CORS headers (internal service, but good practice)
  res.setHeader("Content-Type", "application/json");

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", version: VERSION }));
    return;
  }

  if (url.pathname === "/proxy" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const result = await handleProxy(body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: err.message, code: "BAD_REQUEST" }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, BIND, () => {
  console.log(`[connector-runtime] v${VERSION} listening on ${BIND}:${PORT}`);
});
