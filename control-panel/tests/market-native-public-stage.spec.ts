import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { stageMarketNativeArtifact } from '../src/lib/market/native-artifact';
import { parseMarketRepoURL } from '../src/lib/market/source';
import { ContainerSchema } from '../src/lib/market/schema';
import { sensitivitySafeInstallError, sanitiseInstallEvent } from '../src/lib/market/install-tracker';

const exec = promisify(execFile);
const sha = (data: Buffer|string) => createHash('sha256').update(data).digest('hex');
const container = (artifactSHA256?: string) => ContainerSchema.parse({name:'main',type:'lxd',image:'debian/12',source:{repo:'YouEye-Platform/Search',...(artifactSHA256 ? {artifactSHA256} : {})},port:3000});

test('held native releases stage from the protected cache without publication and reject pinned tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-cached-stage-'));
  const originalFetch = globalThis.fetch;
  const originalCache = process.env.YOUEYE_RELEASE_CACHE;
  try {
    await mkdir(join(root, 'payload'));
    await mkdir(join(root, 'objects'));
    await writeFile(join(root, 'payload/server.js'), 'console.log("app")');
    await exec('tar', ['-cf', join(root, 'fixture.tar'), '-C', join(root, 'payload'), '.']);
    const bytes = await readFile(join(root, 'fixture.tar'));
    const base = 'https://github.com/YouEye-Platform/Search/releases/download/v0.5.1/';
    const saveCache = async (data: Buffer) => {
      await writeFile(join(root, 'objects', sha(data)), data, {mode:0o600});
      await writeFile(join(root, 'index.json'), JSON.stringify({schema:'youeye.release-cache.v1', objects:{[base + 'standalone.tar']:{sha256:sha(data), bytes:data.length}}}), {mode:0o600});
    };
    await saveCache(bytes);
    process.env.YOUEYE_RELEASE_CACHE = root;
    const assetRequests: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/YouEye-Platform/Search/releases')) {
        return Response.json([{tag_name:'v0.5.1', assets:[{name:'standalone.tar',browser_download_url:base+'standalone.tar'}]}]);
      }
      assetRequests.push(url);
      return new Response(null, {status:404});
    };
    const source = parseMarketRepoURL('https://github.com/YouEye-Platform/Market', {branch:'main'});
    const stage = (digest?: string) => stageMarketNativeArtifact(root, container(digest), source);
    assert.deepEqual((await stage(sha(bytes))).verification, {status:'manifest'});
    assert.deepEqual(assetRequests, []);

    // A cache entry is transport integrity only; the manifest pin still decides.
    const other = Buffer.from('other cached payload');
    await saveCache(other);
    await assert.rejects(stage(sha(bytes)), /manifest SHA-256/);
    assert.deepEqual(assetRequests, []);

    // Corrupt cached bytes fail closed without fetching a replacement.
    await writeFile(join(root, 'objects', sha(other)), Buffer.alloc(other.length));
    await assert.rejects(stage(sha(bytes)), /digest rejected|download failed/);
    assert.deepEqual(assetRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) delete process.env.YOUEYE_RELEASE_CACHE;
    else process.env.YOUEYE_RELEASE_CACHE = originalCache;
    await rm(root, {recursive:true, force:true});
  }
});

test('public Stable/Beta native packages stage through the release CDN with only standalone.tar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-public-stage-'));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(root, 'payload'));
    await writeFile(join(root, 'payload/server.js'), 'console.log("app")');
    await exec('tar', ['-cf',join(root,'fixture.tar'),'-C',join(root,'payload'),'.']);
    const bytes = await readFile(join(root,'fixture.tar'));
    for (const channel of ['stable','beta'] as const) {
      const tag = channel === 'stable' ? 'v0.5.1' : 'beta-v0.5.1';
      const base = `https://github.com/YouEye-Platform/Search/releases/download/${tag}/`;
      let payload = bytes;
      const calls: string[] = [];
      globalThis.fetch = async input => {
        const url = String(input);calls.push(url);
        if(url.startsWith('https://api.github.com/repos/YouEye-Platform/Search/releases')) {
          return Response.json([{tag_name:tag,assets:[{name:'standalone.tar',browser_download_url:base+'standalone.tar'}]}]);
        }
        if(url===base+'standalone.tar') return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture?sig=temporary'}});
        if(url.startsWith('https://release-assets.githubusercontent.com/fixture')) return new Response(payload);
        throw new Error('Unexpected request '+url);
      };
      const source = parseMarketRepoURL('https://github.com/YouEye-Platform/Market',{branch:channel==='beta'?'beta':'main'});
      const artifact = await stageMarketNativeArtifact(root,container(sha(bytes)),source);
      assert.deepEqual(artifact.verification,{status:'manifest'});
      assert.equal(artifact.tag,tag);
      assert.equal(artifact.artifactSHA256,sha(bytes));
      assert.ok(calls.some(url=>url.startsWith('https://release-assets.githubusercontent.com/')));
      // Only the release listing and the archive itself are requested.
      assert.ok(calls.every(url=>url.startsWith('https://api.github.com/')||url===base+'standalone.tar'||url.startsWith('https://release-assets.githubusercontent.com/fixture')));
      payload=Buffer.from('tampered');
      await assert.rejects(stageMarketNativeArtifact(root,container(sha(bytes)),source),/manifest SHA-256/);
    }
    const error = new Error('Native app artifact does not match the manifest SHA-256',{cause:new Error('secret=unsafe')});
    error.name='MarketNativeArtifactPolicyError';
    const message=sensitivitySafeInstallError(error);
    const event=sanitiseInstallEvent({step:0,totalSteps:0,status:'error',message,detail:'secret=unsafe'});
    assert.equal(event.message,'Native app artifact does not match the manifest SHA-256');
    assert.equal(JSON.stringify(event).includes('unsafe'),false);
  } finally {globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});
