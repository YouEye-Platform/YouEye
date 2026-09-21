import { promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { createHash, createPublicKey, verify } from 'crypto';
import sourcePolicy from '../../../../releasecache/distribution-policy.json';

export type DistributionPolicy = { schema: string; origin: string; keys: Record<string, string> };
type Release = { tag_name: string; draft?: boolean; prerelease?: boolean; published_at: string; assets?: { browser_download_url: string }[] };
type Catalog = { schema: string; channel: string; sequence: number; issued_at: string; expires_at: string; repositories: Record<string, { releases: Release[]; commits?: Record<string, string> }> };
const repositories = new Set(['YouEye', 'Market', 'Wiki', 'Search', 'Notes', 'Cinema', 'Weather', 'Translate', 'Canvas', 'Pointer']);
const cached = new Map<string, { catalog: Catalog; digest: string; fetched: number }>();
const pending = new Map<string, Promise<Catalog | null>>();
const MAX_BYTES = 16 * 1024 * 1024;

export function verifyDistribution(raw: string, channel: string, pem: string, now = Date.now(), retained = false): { catalog: Catalog; digest: string } {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Distribution response is too large');
  const envelope = JSON.parse(raw);
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Invalid distribution envelope');
  const payload = Buffer.from(envelope.payload, 'base64');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) throw new Error('Distribution signature rejected');
  const catalog = JSON.parse(payload.toString()) as Catalog;
  const issued = Date.parse(catalog.issued_at), expires = Date.parse(catalog.expires_at);
  if (catalog.schema !== 'youeye.distribution.v1' || catalog.channel !== channel || !['stable', 'beta'].includes(channel) || !Number.isSafeInteger(catalog.sequence) || catalog.sequence < 1 || !catalog.repositories || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300_000 || (!retained && expires <= now) || expires <= issued || expires - issued > 31 * 86400_000) throw new Error('Distribution metadata expired or invalid');
  for (const [name, repo] of Object.entries(catalog.repositories)) {
    if (!Array.isArray(repo.releases)) throw new Error('Invalid distribution repository');
    for (const release of repo.releases) {
      if (!release.tag_name || release.draft || Boolean(release.prerelease) !== (channel === 'beta')) throw new Error('Distribution release channel mismatch');
      for (const asset of release.assets || []) {
        const url = new URL(asset.browser_download_url);
        const prefix = `/YouEye-Platform/${name}/releases/download/${release.tag_name}/`;
        if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix) || !/^[A-Za-z0-9._-]+$/.test(url.pathname.slice(prefix.length))) throw new Error('Distribution artifact source mismatch');
      }
    }
    for (const [ref, sha] of Object.entries(repo.commits || {})) {
      if (name !== 'Market' || !/^[0-9a-f]{40}$/.test(sha) || !['main', 'beta', sha].includes(ref) || (ref === 'main' && channel !== 'stable') || (ref === 'beta' && channel !== 'beta')) throw new Error('Invalid distribution Market commit');
    }
  }
  return { catalog, digest: createHash('sha256').update(payload).digest('hex') };
}

async function load(policy: DistributionPolicy, channel: string, fetchImpl: typeof fetch): Promise<Catalog | null> {
  const pem = policy.keys[channel];
  if (!pem) return null;
  const endpoint = `${policy.origin}/v1/${channel}.json`;
  const cacheKey = endpoint + ':' + createHash('sha256').update(pem).digest('hex');
  let old = cached.get(cacheKey);
  const file = path.join(process.env.YOUEYE_DISTRIBUTION_STATE || process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "youeye-distribution", "ts", createHash("sha256").update(cacheKey).digest("hex") + ".json");
  if (old && Date.now() - old.fetched < 900_000 && Date.parse(old.catalog.expires_at) > Date.now()) return old.catalog;
  const inflight = pending.get(cacheKey);
  if (inflight) return inflight;
  const request = (async () => {
    if (!old) {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || (stat.mode & 0o022) || stat.size > MAX_BYTES) throw new Error('Invalid distribution cache');
        old = { ...verifyDistribution(await fs.readFile(file, 'utf8'), channel, pem, Date.now(), true), fetched: stat.mtimeMs };
        if (Date.now() - old.fetched < 900_000 && Date.parse(old.catalog.expires_at) > Date.now()) { cached.set(cacheKey, old); return old.catalog; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store' });
    if (response.status === 404 && !old) return null;
    if (!response.ok) throw new Error(`Release distribution returned HTTP ${response.status}`);
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Distribution response is too large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty distribution response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > MAX_BYTES) throw new Error('Distribution response is too large'); chunks.push(item.value); } }
    finally { await reader.cancel(); }
    const raw = Buffer.concat(chunks).toString();
    const entry = verifyDistribution(raw, channel, pem);
    if (old && (entry.catalog.sequence < old.catalog.sequence || (entry.catalog.sequence === old.catalog.sequence && entry.digest !== old.digest))) throw new Error('Distribution rollback or sequence conflict rejected');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + process.pid + '.' + Date.now();
    try { const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); } await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
    cached.set(cacheKey, { ...entry, fetched: Date.now() });
    return entry.catalog;
  })();
  pending.set(cacheKey, request);
  try { return await request; } finally { pending.delete(cacheKey); }
}

export async function distributionBytes(source: string, policy: DistributionPolicy = sourcePolicy, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  const url = new URL(source), parts = url.pathname.split('/').filter(Boolean);
  if (!policy.origin || url.protocol !== 'https:' || url.host !== 'api.github.com' || url.username || url.password || url.hash || parts[0] !== 'repos' || parts[1] !== 'YouEye-Platform' || !repositories.has(parts[2])) return null;
  const repo = parts[2], kind = parts[3];
  const tag = kind === 'releases' && parts.length === 6 && parts[4] === 'tags' ? parts[5] : null;
  const commit = kind === 'commits' && repo === 'Market' && parts.length === 5 ? parts[4] : null;
  if (!(kind === 'releases' && parts.length === 4) && !tag && !commit) return null;
  if ([...url.searchParams.keys()].some(key => !['page', 'per_page'].includes(key))) return null;
  const origin = new URL(policy.origin);
  if (policy.schema !== 'youeye.distribution-policy.v1' || origin.protocol !== 'https:' || origin.origin !== policy.origin || !Object.keys(policy.keys).length) throw new Error('Invalid distribution policy');
  const catalogs = await Promise.all(['stable', 'beta'].map(channel => load(policy, channel, fetchImpl)));
  if (commit) {
    const sha = catalogs.map(c => c?.repositories[repo]?.commits?.[commit]).find(Boolean);
    if (!sha) throw new Error('Market commit is not published in release distribution');
    return Buffer.from(JSON.stringify({ sha }));
  }
  const releases = catalogs.flatMap(c => c?.repositories[repo]?.releases || []).sort((a, b) => b.published_at.localeCompare(a.published_at));
  if (tag) {
    const release = releases.find(r => r.tag_name === tag);
    if (!release) throw new Error('Exact release is not published in release distribution');
    return Buffer.from(JSON.stringify(release));
  }
  const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('per_page') || 30);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(size) || size < 1 || size > 100) throw new Error('Invalid release page');
  return Buffer.from(JSON.stringify(releases.slice((page - 1) * size, page * size)));
}
