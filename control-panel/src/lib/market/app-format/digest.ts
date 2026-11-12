/**
 * Manifest digest: SHA-256 over the canonical JSON (sorted keys) of the manifest without
 * `listing:`, followed by each setup file as its name and canonical JSON, in name order.
 * Store text changes never change the digest.
 */

import { createHash } from 'node:crypto';

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJSON(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(',')}}`;
}

export function manifestDigest(rawManifest: unknown, setups: Array<{ name: string; raw: unknown }> = []): string {
  const hash = createHash('sha256');
  const manifest = rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest)
    ? Object.fromEntries(Object.entries(rawManifest as Record<string, unknown>).filter(([key]) => key !== 'listing'))
    : rawManifest;
  hash.update(canonicalJSON(manifest));
  for (const setup of [...setups].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update('\n');
    hash.update(setup.name);
    hash.update('\n');
    hash.update(canonicalJSON(setup.raw));
  }
  return `sha256:${hash.digest('hex')}`;
}
