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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.PORT || "3001", 10);
const BIND = process.env.HOSTNAME || "0.0.0.0";
const VERSION = "0.2.0";
const ASSETS_DIR = process.env.ASSETS_DIR || "/opt/youeye-connectors/assets";

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
    // The manifest code defines a `function transform(data) { ... }`.
    // We execute it and then call transform(data).
    const wrapped = `${code}\nresult = transform(data);`;
    runInNewContext(wrapped, sandbox, {
      timeout: 1000,
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

// ─── UI Asset Serving ───────────────────────────────────────

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Build CSP header from connector manifest's allowedHosts.
 * Local connectors only get 'self' + *.devvm.test.
 * Internet connectors get allowed hosts appended.
 */
function buildCSP(allowedHosts, networkType) {
  const hosts = (allowedHosts || []).map((h) => `https://${h}`).join(" ");
  const devvmTest = "https://*.devvm.test";
  if (networkType === "local" || !hosts) {
    return `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${devvmTest}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'none'`;
  }
  return `default-src 'self'; script-src 'self' 'unsafe-inline' ${hosts}; connect-src 'self' ${devvmTest} ${hosts}; img-src 'self' data: blob: ${hosts}; style-src 'self' 'unsafe-inline'; frame-src 'none'`;
}

/**
 * Serve a connector's UI asset file.
 * Path: /{connectorId}/{filename} e.g. /spotify-music/player.html
 */
function handleAsset(connectorId, filename, res) {
  // Prevent path traversal
  const safe = filename.replace(/\.\./g, "").replace(/[^a-zA-Z0-9._-]/g, "");
  const filePath = join(ASSETS_DIR, connectorId, safe);

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Asset not found: ${connectorId}/${safe}` }));
    return;
  }

  const ext = "." + safe.split(".").pop();
  const mime = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = readFileSync(filePath);

    // Try to load manifest for CSP headers
    const manifestPath = join(ASSETS_DIR, connectorId, "connector.yaml");
    let csp = buildCSP([], "local");
    if (existsSync(manifestPath)) {
      try {
        // Quick YAML parsing for allowedHosts — just extract the hosts
        const yaml = readFileSync(manifestPath, "utf-8");
        const hostMatches = yaml.match(/allowedHosts:\s*\n((?:\s*-\s*"[^"]+"\s*\n?)*)/);
        if (hostMatches) {
          const hosts = hostMatches[1].match(/"([^"]+)"/g)?.map((h) => h.replace(/"/g, "")) || [];
          const networkMatch = yaml.match(/network:\s*"?(\w+)"?/);
          const network = networkMatch?.[1] || "local";
          csp = buildCSP(hosts, network);
        }
      } catch { /* ignore YAML parse errors */ }
    }

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "ALLOWALL", // served via iframe from apps
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: `Failed to read asset: ${err.message}` }));
  }
}

// ─── PostMessage Protocol Definitions ───────────────────────

const PROTOCOLS = {
  "youeye-player-v1": {
    commands: ["play", "pause", "seek", "volume", "queue", "stop"],
    events: ["youeye-player-ready", "state", "ended", "error"],
    description: "Audio/video playback control",
  },
  "youeye-map-v1": {
    commands: ["setCenter", "addMarker", "removeMarker", "fitBounds", "setLayer"],
    events: ["youeye-map-ready", "click", "moveend", "markerClick"],
    description: "Interactive map rendering",
  },
  "youeye-viewer-v1": {
    commands: ["load", "show", "next", "prev", "zoom"],
    events: ["youeye-viewer-ready", "state", "select"],
    description: "Image/document viewing",
  },
  "youeye-card-v1": {
    commands: [],
    events: ["youeye-card-ready"],
    description: "Info card ready signal",
  },
};

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

  // GET /protocols — expose PostMessage protocol definitions
  if (url.pathname === "/protocols" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ protocols: PROTOCOLS }));
    return;
  }

  // GET /assets/{connectorId}/{filename} — serve connector UI assets
  const assetMatch = url.pathname.match(/^\/assets\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+)$/);
  if (assetMatch && req.method === "GET") {
    const [, connectorId, filename] = assetMatch;
    handleAsset(connectorId, filename, res);
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, BIND, () => {
  console.log(`[connector-runtime] v${VERSION} listening on ${BIND}:${PORT}`);
});
