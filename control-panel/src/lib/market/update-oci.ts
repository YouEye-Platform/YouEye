import { updateDigest } from './update-workspace';
import { parseOCIImage } from '@/lib/incus/snapshot';

const accepts = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Resolve the public registry artifact before mutation, then rebuild by digest. */
export async function freezeUpdateOCIImage(image: string, request: typeof fetch = fetch) {
  const parsed = parseOCIImage(image);
  const origin = new URL(parsed.server);
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('OCI update source must use credential-free HTTPS');
  const registry = origin.hostname === 'docker.io' ? 'https://registry-1.docker.io' : origin.origin;
  const split = parsed.alias.includes('@') ? parsed.alias.lastIndexOf('@') : parsed.alias.lastIndexOf(':');
  let repository = split < 0 ? parsed.alias : parsed.alias.slice(0, split);
  const reference = split < 0 ? 'latest' : parsed.alias.slice(split + 1);
  if (origin.hostname === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`;
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(repository) || repository.split('/').some(p => p === '..')
    || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/.test(reference)) throw new Error('Invalid OCI artifact reference');
  const url = `${registry}/v2/${repository}/manifests/${encodeURIComponent(reference)}`;
  const headers: Record<string, string> = { Accept: accepts };
  let response = await request(url, { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? '';
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    const service = /service="([^"]+)"/.exec(challenge)?.[1];
    if (!realm || !service) throw new Error('OCI artifact authentication is unsupported');
    const tokenURL = new URL(realm);
    // Registry challenges cannot redirect token traffic to a foreign owner.
    const dockerAuth = origin.hostname === 'docker.io' && tokenURL.hostname === 'auth.docker.io';
    if (tokenURL.protocol !== 'https:' || tokenURL.username || tokenURL.password
      || (!dockerAuth && tokenURL.origin !== registry)) throw new Error('OCI token authority does not match registry');
    tokenURL.searchParams.set('service', service);
    tokenURL.searchParams.set('scope', `repository:${repository}:pull`);
    const tokenResponse = await request(tokenURL, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!tokenResponse.ok) throw new Error('OCI public artifact authentication failed');
    const token = await tokenResponse.json() as { token?: string; access_token?: string };
    if (!(token.token ?? token.access_token)) throw new Error('OCI public artifact authentication failed');
    headers.Authorization = `Bearer ${token.token ?? token.access_token}`;
    response = await request(url, { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  }
  if (!response.ok || !response.body) throw new Error('OCI update artifact could not be resolved');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > 4 * 1024 * 1024) throw new Error('OCI artifact manifest is too large');
    chunks.push(chunk);
  }
  const digest = updateDigest(Buffer.concat(chunks));
  const claimed = response.headers.get('docker-content-digest');
  if ((claimed && claimed !== `sha256:${digest}`)
    || (reference.startsWith('sha256:') && reference !== `sha256:${digest}`)) {
    throw new Error('OCI artifact digest does not match source');
  }
  return { image: `${origin.host}/${repository}@sha256:${digest}`, sha256: digest };
}
