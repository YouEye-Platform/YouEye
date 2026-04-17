/**
 * Serves connector UI assets (player.html, map.html, etc.) from YE-AppMarket.
 * URL pattern: /ui/:connectorId/:filename
 * Assets are cached in memory with 5-min TTL.
 * CSP headers are built from the connector manifest's allowedHosts.
 */

import { getManifest } from './manifests.mjs';

const GITEA_BASE = process.env.GITEA_BASE_URL || 'https://git.byka.wtf';
const REPO_OWNER = 'potemsla';
const REPO_NAME = 'YE-AppMarket';
const BRANCH = process.env.RELEASE_BRANCH || 'main';
const CACHE_TTL = 5 * 60 * 1000;

const assetCache = new Map();

function rawUrl(filePath) {
  return `${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/raw/branch/${BRANCH}/${filePath}`;
}

function buildCSP(manifest) {
  const allowedHosts = manifest.permissions?.network?.allowedHosts || [];
  const networkMode = manifest.metadata?.network || 'local';

  const connectSrc = ["'self'"];
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  const imgSrc = ["'self'", 'data:', 'blob:'];

  if (networkMode === 'internet' && allowedHosts.length > 0) {
    for (const host of allowedHosts) {
      const h = host.startsWith('*.') ? host : `https://${host}`;
      connectSrc.push(h);
      scriptSrc.push(h);
      imgSrc.push(h);
    }
  }

  // Always allow *.devvm.test for postMessage communication
  connectSrc.push('https://*.devvm.test');

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    `img-src ${imgSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `frame-src 'none'`,
  ].join('; ');
}

export async function handleUIAsset(req, res, path, sendJSON) {
  // /ui/:connectorId/:filename
  const parts = path.replace('/ui/', '').split('/');
  if (parts.length < 2) {
    return sendJSON(res, 400, { error: 'Invalid UI asset path' });
  }

  const connectorId = parts[0];
  const filename = parts.slice(1).join('/');

  // Prevent path traversal
  if (filename.includes('..') || filename.startsWith('/')) {
    return sendJSON(res, 400, { error: 'Invalid filename' });
  }

  const cacheKey = `${connectorId}/${filename}`;
  const cached = assetCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    const csp = cached.csp;
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Content-Length': Buffer.byteLength(cached.content),
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(cached.content);
  }

  try {
    // Fetch manifest for CSP
    let manifest;
    try { manifest = await getManifest(connectorId); } catch {
      return sendJSON(res, 404, { error: `Connector "${connectorId}" not found` });
    }

    // Fetch the asset file
    const assetPath = `connectors/${connectorId}/${filename}`;
    const url = rawUrl(assetPath);
    const fetchRes = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!fetchRes.ok) {
      return sendJSON(res, 404, { error: `Asset not found: ${filename}` });
    }

    const content = await fetchRes.text();
    const contentType = filename.endsWith('.html') ? 'text/html; charset=utf-8'
      : filename.endsWith('.js') ? 'application/javascript; charset=utf-8'
      : filename.endsWith('.css') ? 'text/css; charset=utf-8'
      : 'application/octet-stream';

    const csp = buildCSP(manifest);

    assetCache.set(cacheKey, { content, contentType, csp, fetchedAt: Date.now() });

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(content),
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(content);
  } catch (err) {
    return sendJSON(res, 500, { error: `Failed to serve asset: ${err.message}` });
  }
}
