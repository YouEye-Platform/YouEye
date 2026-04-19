import http from 'node:http';
import { handleProxy } from './proxy.mjs';
import { handleHealth } from './health.mjs';
import { handleUIAsset } from './ui-assets.mjs';
import { handleManifests } from './manifests.mjs';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOSTNAME || '0.0.0.0';

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 1024 * 1024; // 1MB max request body
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    // GET /health
    if (path === '/health' && req.method === 'GET') {
      return handleHealth(req, res, sendJSON);
    }

    // POST /proxy
    if (path === '/proxy' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body) return sendJSON(res, 400, { error: 'Invalid JSON body' });
      return handleProxy(req, res, body, sendJSON);
    }

    // GET /manifests or GET /manifests?id=xxx
    if (path === '/manifests' && req.method === 'GET') {
      return handleManifests(req, res, url, sendJSON);
    }

    // GET /ui/:connectorId/* — serve UI assets
    if (path.startsWith('/ui/') && req.method === 'GET') {
      return handleUIAsset(req, res, path, sendJSON);
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[connector-runtime] Unhandled error:', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`[connector-runtime] Listening on ${HOST}:${PORT}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
