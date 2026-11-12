import { createHash } from 'node:crypto';
import { productTag, type ProductBuild, type ProductRelease } from '../../src/lib/releases/product-release';

export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const tree = 'a'.repeat(40);

/** A host-independent product release document over the given assets. */
export function productFixture(product: string, version: string, repository: string, assets: Record<string, Buffer>, options: { kind?: ProductBuild['kind']; primary?: string; sequence?: number; contract?: Buffer; build?: string } = {}) {
  // `build` defaults to `version` (a dev release); a promoted release passes the build it renames.
  const build: ProductBuild = {schema:'youeye.product-build.v1',product,kind:options.kind ?? 'native',build_version:options.build ?? version,source_tree:tree,
    input_sha256:'b'.repeat(64),contract_sha256:sha(options.contract ?? Buffer.from('contract')),primary:options.primary ?? 'standalone.tar',
    assets:Object.entries(assets).map(([name, bytes]) => ({name,sha256:sha(bytes),size_bytes:bytes.length}))};
  const release: ProductRelease = {schema:'youeye.product-release.v1',product,version,tag:productTag(product,version),source_tree:tree,
    sequence:options.sequence ?? 1762950000,minimum_reader:1,authority:'digest',build_manifest_base64:Buffer.from(JSON.stringify(build)).toString('base64')};
  return {build, release, raw: Buffer.from(JSON.stringify(release)), repository, tag: release.tag};
}


/**
 * A fake release host: plain downloads of the given URLs only. Any request to
 * a release-listing API fails the test; unknown files are 404.
 */
export function fakeReleaseHost(files: Map<string, Buffer>, status: Record<string, number> = {}) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'api.github.com' || /\/api\/v\d+\/repos\//.test(parsed.pathname)) {
      throw new Error(`release-listing API called: ${url}`);
    }
    if (status[url]) return new Response('refused', { status: status[url] });
    const body = files.get(url);
    if (!body) return new Response('missing', { status: 404 });
    return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) } });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

/** The Spine answer for GET /api/releases/index over the given entries. */
export function spineIndex(repository: string, channel: string, entries: Record<string, { repository: string; tag: string; version: string; build?: string; raw: Buffer; document?: string }>) {
  const products = Object.fromEntries(Object.entries(entries).map(([product, e]) => [product, {
    repository: e.repository, tag: e.tag, version: e.version, build: e.build ?? e.version, document: e.document ?? 'product-release.json', sha256: sha(e.raw),
  }]));
  const index = { schema: 'youeye.channel.v1', channel, published_at: '2026-11-12T10:00:00Z', products };
  return { repository, channel, index, index_sha256: sha(JSON.stringify(index)) };
}
