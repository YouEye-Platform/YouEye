import { resolve as dnsResolve } from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_DOMAIN_SUFFIXES = ['.youeye', '.internal', '.local'];
const BLOCKED_DOMAIN_EXACT = ['localhost'];

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0
    if (parts[0] === 0) return true;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  }
  return false;
}

/**
 * Check if a URL is safe to fetch (not targeting internal infrastructure).
 * @param {string} urlStr - The URL to check
 * @param {'local'|'internet'} networkMode - Connector's declared network mode
 * @param {string[]} allowedHosts - Connector's declared allowed hosts
 * @returns {{ safe: boolean, reason?: string }}
 */
export function checkSSRF(urlStr, networkMode, allowedHosts) {
  let parsed;
  try { parsed = new URL(urlStr); } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block .youeye, .internal, .local domains (always, regardless of mode)
  for (const suffix of BLOCKED_DOMAIN_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { safe: false, reason: `Blocked domain suffix: ${suffix}` };
    }
  }
  for (const exact of BLOCKED_DOMAIN_EXACT) {
    if (hostname === exact) {
      return { safe: false, reason: `Blocked domain: ${exact}` };
    }
  }

  // Block IP literals that are private
  if (net.isIP(hostname) && isPrivateIP(hostname)) {
    return { safe: false, reason: 'Private IP address blocked' };
  }

  // For internet mode: allowedHosts is required — check it
  if (networkMode === 'internet') {
    if (!isHostAllowed(hostname, allowedHosts)) {
      return { safe: false, reason: `Host ${hostname} not in allowedHosts` };
    }
  }

  // For local mode: should ONLY reach declared allowedHosts
  // (but we already blocked .youeye and private IPs above)
  if (networkMode === 'local') {
    return { safe: false, reason: 'Local connectors cannot make external requests' };
  }

  return { safe: true };
}

function isHostAllowed(hostname, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  return allowedHosts.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return hostname.endsWith(suffix) || hostname === pattern.slice(2);
    }
    return hostname === pattern;
  });
}

/**
 * Resolve hostname and verify resolved IPs are not private.
 * This catches DNS rebinding attacks where a public hostname resolves to a private IP.
 */
export async function checkResolvedIP(hostname) {
  if (net.isIP(hostname)) {
    return isPrivateIP(hostname)
      ? { safe: false, reason: 'Resolved to private IP' }
      : { safe: true };
  }
  try {
    const addresses = await dnsResolve(hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return { safe: false, reason: `DNS resolved ${hostname} to private IP ${addr}` };
      }
    }
    return { safe: true };
  } catch {
    // DNS resolution failed — let the fetch fail naturally
    return { safe: true };
  }
}
