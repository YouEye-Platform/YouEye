import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { stageMarketNativeArtifact } from '../src/lib/market/native-artifact';
import { ContainerSchema } from '../src/lib/market/schema';
import { parseMarketRepoURL } from '../src/lib/market/source';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

test('Forgejo native staging uses exact release attachments with no signature files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-forgejo-stage-'));
  const originalFetch = globalThis.fetch;
  const repo = 'https://forge.example/alice/App';
  try {
    await mkdir(join(root, 'payload'));
    await writeFile(join(root, 'payload/server.js'), 'console.log("ready")');
    await promisify(execFile)('tar', ['-cf', join(root, 'fixture.tar'), '-C', join(root, 'payload'), '.']);
    const bytes = await readFile(join(root, 'fixture.tar'));
    const base = `${repo}/releases/download/v1.2.3/`;
    const build = {schema:'youeye.product-build.v1',product:'notes',kind:'native',build_version:'1.2.3',source:repo,branch:'main',source_commit:'a'.repeat(40),tag:'v1.2.3',input_sha256:'b'.repeat(64),contract_sha256:'c'.repeat(64),primary:'standalone.tar',
      assets:[{name:'standalone.tar',url:base+'standalone.tar',sha256:sha(bytes),size_bytes:bytes.length}]};
    const productRelease = Buffer.from(JSON.stringify({schema:'youeye.product-release.v1',product:'notes',version:'1.2.3',source:repo,branch:'main',tag:'v1.2.3',channel:'feature',sequence:1,minimum_reader:1,authority:'digest',build_manifest_base64:Buffer.from(JSON.stringify(build)).toString('base64')}));
    const contents = new Map<string, Buffer>([['standalone.tar', bytes], ['product-release.json', productRelease]]);
    const validAssets = [...contents.keys()].map((name, i) => ({ name, browser_download_url: base + name,
      uuid: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}` }));
    let assets = validAssets.filter(a => a.name === 'standalone.tar');
    const calls: string[] = [];
    let redirect = '';
    globalThis.fetch = async input => {
      const url = String(input); calls.push(url);
      if (url.startsWith('https://forge.example/api/v1/repos/alice/App/releases')) {
        return Response.json([{ tag_name: 'v1.2.3', assets }]);
      }
      const asset = validAssets.find(a => url === `https://forge.example/attachments/${a.uuid}`);
      if (asset) {
        if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
        return new Response(new Uint8Array(contents.get(asset.name)!));
      }
      // Product blobs use their canonical build URL (the private-mirror blob
      // path is covered in product-release.spec.ts).
      if (url.startsWith(base) && contents.has(url.slice(base.length))) return new Response(new Uint8Array(contents.get(url.slice(base.length))!));
      throw new Error('Unexpected request ' + url);
    };
    const source = parseMarketRepoURL('https://forge.example/alice/Market');
    const container = (artifactSHA256?: string) => ContainerSchema.parse({ name: 'main', type: 'lxd', image: 'debian/12', source: { repo: 'alice/App', ...(artifactSHA256 ? { artifactSHA256 } : {}) }, port: 3000 });
    const stage = (artifactSHA256?: string, product?: string) => stageMarketNativeArtifact(root, container(artifactSHA256), source, undefined, product);

    // A bare standalone.tar is enough; it is authorized by the manifest selection.
    const plain = await stage();
    assert.deepEqual(plain.verification, { status: 'manifest' });
    assert.equal(plain.artifactSHA256, sha(bytes));
    assert.equal(calls.some(url => url.startsWith(base)), false, 'plain staging uses exact attachments');
    // Only the release listing and the archive attachment are requested.
    assert.ok(calls.every(url => url.startsWith('https://forge.example/api/v1/') || url === `https://forge.example/attachments/${validAssets[0].uuid}`));
    assert.equal((await stage(sha(bytes))).artifactSHA256, sha(bytes));
    await assert.rejects(stage('f'.repeat(64)), /manifest SHA-256/);
    contents.set('standalone.tar', Buffer.from('tampered'));
    await assert.rejects(stage(sha(bytes)), /manifest SHA-256/);
    contents.set('standalone.tar', bytes);
    assets = [...assets, { ...assets[0] }]; await assert.rejects(stage(), /ambiguous/); assets = validAssets.filter(a => a.name === 'standalone.tar');
    assets = [{ ...assets[0], uuid: '../outside' }]; await assert.rejects(stage(), /attachment identity/); assets = validAssets.filter(a => a.name === 'standalone.tar');
    redirect = 'https://attacker.example/asset';
    await assert.rejects(stage(), /outside its release source/); redirect = '';

    // An unsigned product release binds the archive by its build digest.
    assets = structuredClone(validAssets);
    const product = await stage(undefined, 'notes');
    assert.equal(product.verification.status, 'product-release');
    assert.equal(product.verification.status === 'product-release' && product.verification.releaseSHA256, sha(productRelease));
    assert.equal(product.productRelease?.manifestSHA256, sha(productRelease));
    await assert.rejects(stage('f'.repeat(64), 'notes'), /manifest SHA-256/);
    contents.set('standalone.tar', Buffer.from('tampered'));
    await assert.rejects(stage(undefined, 'notes'), /differs/);
    contents.set('standalone.tar', bytes);
    await assert.rejects(stage(undefined, 'wiki'), /differs/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
