import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';
import { stageMarketNativeArtifact } from '../src/lib/market/native-artifact';
import { parseMarketRepoURL } from '../src/lib/market/source';
import { ContainerSchema } from '../src/lib/market/schema';
import { sensitivitySafeInstallError, sanitiseInstallEvent } from '../src/lib/market/install-tracker';

const exec = promisify(execFile);
test('held native releases verify cached signature assets without publication and reject tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-cached-stage-'));
  const originalFetch = globalThis.fetch;
  const originalCache = process.env.YOUEYE_RELEASE_CACHE;
  const policy = publicPolicy as {schema:string;keys:Record<string,string>};
  const originalKeys = policy.keys;
  try {
    await mkdir(join(root, 'payload'));
    await mkdir(join(root, 'objects'));
    await writeFile(join(root, 'payload/server.js'), 'console.log("app")');
    await exec('tar', ['-cf', join(root, 'fixture.tar'), '-C', join(root, 'payload'), '.']);
    const bytes = await readFile(join(root, 'fixture.tar'));
    const key = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({type:'spki', format:'pem'}).toString();
    policy.keys = {...originalKeys, stable:pem};
    const sha = (data: Buffer|string) => createHash('sha256').update(data).digest('hex');
    const base = 'https://github.com/YouEye-Platform/Search/releases/download/v0.5.1/';
    const sums = Buffer.from(`${sha(bytes)}  standalone.tar\n${sha(pem)}  release-public.pub\n${sha('{}')}  provenance.json\n${sha('{}')}  sbom.spdx.json\n`);
    const assets = new Map<string, Buffer>([
      ['standalone.tar', bytes], ['release-public.pub', Buffer.from(pem)],
      ['SHA256SUMS', sums], ['SHA256SUMS.sig', sign(null, sums, key.privateKey)],
      ['provenance.json', Buffer.from('{}')], ['sbom.spdx.json', Buffer.from('{}')],
    ]);
    const saveCache = async () => {
      const objects: Record<string, {sha256:string;bytes:number}> = {};
      for (const [name, data] of assets) {
        const digest = sha(data);
        await writeFile(join(root, 'objects', digest), data, {mode:0o600});
        objects[base + name] = {sha256:digest, bytes:data.length};
      }
      await writeFile(join(root, 'index.json'), JSON.stringify({schema:'youeye.release-cache.v1', objects}), {mode:0o600});
    };
    await saveCache();
    process.env.YOUEYE_RELEASE_CACHE = root;
    const assetRequests: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/YouEye-Platform/Search/releases')) {
        return Response.json([{tag_name:'v0.5.1', assets:[...assets.keys()].map(name => ({name,browser_download_url:base+name}))}]);
      }
      assetRequests.push(url);
      return new Response(null, {status:404});
    };
    const container = ContainerSchema.parse({name:'main',type:'lxd',image:'debian/12',source:{repo:'YouEye-Platform/Search'},port:3000});
    const source = parseMarketRepoURL('https://github.com/YouEye-Platform/Market', {branch:'main'});
    const stage = () => stageMarketNativeArtifact(root, container, source);
    assert.equal((await stage()).signature.status, 'verified-stable');
    assert.deepEqual(assetRequests, []);

    // A valid cache digest is transport integrity, not signing authority.
    assets.set('SHA256SUMS.sig', sign(null, sums, generateKeyPairSync('ed25519').privateKey));
    await saveCache();
    await assert.rejects(stage(), /signature or checksum verification failed/);
    assert.deepEqual(assetRequests, []);

    // Corrupt cached evidence must fail closed without fetching a replacement.
    const signature = assets.get('SHA256SUMS.sig')!;
    await writeFile(join(root, 'objects', sha(signature)), Buffer.alloc(signature.length));
    await assert.rejects(stage(), /signature or checksum verification failed/);
    assert.deepEqual(assetRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
    policy.keys = originalKeys;
    if (originalCache === undefined) delete process.env.YOUEYE_RELEASE_CACHE;
    else process.env.YOUEYE_RELEASE_CACHE = originalCache;
    await rm(root, {recursive:true, force:true});
  }
});

test('real native staging verifies public Stable/Beta packages and never downgrades failed signatures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-public-stage-'));
  const originalFetch = globalThis.fetch;
  const policy = publicPolicy as {schema:string;keys:Record<string,string>};
  const originalKeys = policy.keys;
  try {
    await mkdir(join(root, 'payload'));
    await writeFile(join(root, 'payload/server.js'), 'console.log("app")');
    await exec('tar', ['-cf',join(root,'fixture.tar'),'-C',join(root,'payload'),'.']);
    const bytes = await readFile(join(root,'fixture.tar'));
    const stable = generateKeyPairSync('ed25519'), beta = generateKeyPairSync('ed25519');
    const pem = (pair: typeof stable) => pair.publicKey.export({type:'spki',format:'pem'}).toString();
    policy.keys = {stable:pem(stable),beta:pem(beta)};
    const sha = (b: Buffer|string) => createHash('sha256').update(b).digest('hex');
    for (const channel of ['stable','beta'] as const) {
      const tag = channel === 'stable' ? 'v0.5.1' : 'beta-v0.5.1';
      const base = `https://github.com/YouEye-Platform/Search/releases/download/${tag}/`;
      const key = policy.keys[channel];
      const sums = Buffer.from(`${sha(bytes)}  standalone.tar\n${sha(key)}  release-public.pub\n${'a'.repeat(64)}  provenance.json\n${'b'.repeat(64)}  sbom.spdx.json\n`);
      let signature = sign(null,sums,(channel==='stable'?stable:beta).privateKey);
      let payload = bytes, publishedKey = key;
      let signed = true;
      const calls: string[] = [];
      globalThis.fetch = async input => {
        const url = String(input);calls.push(url);
        if(url.startsWith('https://api.github.com/repos/YouEye-Platform/Search/releases')) {
          const names = signed ? ['standalone.tar','release-public.pub','SHA256SUMS','SHA256SUMS.sig','provenance.json','sbom.spdx.json'] : ['standalone.tar'];
          return Response.json([{tag_name:tag,assets:names.map(name=>({name,browser_download_url:base+name}))}]);
        }
        if(url===base+'standalone.tar') return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture?sig=temporary'}});
        if(url.startsWith('https://release-assets.githubusercontent.com/fixture')) return new Response(payload);
        if(url===base+'release-public.pub') return new Response(publishedKey);
        if(url===base+'SHA256SUMS') return new Response(sums);
        if(url===base+'SHA256SUMS.sig') return new Response(signature);
        throw new Error('Unexpected request '+url);
      };
      const container = ContainerSchema.parse({name:'main',type:'lxd',image:'debian/12',source:{repo:'YouEye-Platform/Search'},port:3000});
      const source = parseMarketRepoURL('https://github.com/YouEye-Platform/Market',{branch:channel==='beta'?'beta':'main'});
      const stage = () => stageMarketNativeArtifact(root,container,source);
      const artifact = await stage();
      assert.equal(artifact.signature.status,`verified-${channel}`);
      assert.equal(artifact.signature.status==='unsigned'?null:artifact.signature.keyId,`youeye-${channel}-v1`);
      assert.equal(artifact.artifactSHA256,sha(bytes));
      assert.ok(calls.some(url=>url.startsWith('https://release-assets.githubusercontent.com/')));
      payload=Buffer.from('tampered');
      await assert.rejects(stage(),/signature or checksum verification failed/);payload=bytes;
      signature=sign(null,sums,(channel==='stable'?beta:stable).privateKey);
      await assert.rejects(stage(),/signature or checksum verification failed/);
      publishedKey=pem(generateKeyPairSync('ed25519'));
      await assert.rejects(stage(),/signature or checksum verification failed/);
      signed=false;calls.length=0;
      assert.equal((await stage()).signature.status,'unsigned');
      assert.equal(calls.some(url=>url.endsWith('/SHA256SUMS.sig')),false);
    }
    const error = new Error('Native app signature or checksum verification failed',{cause:new Error('secret=unsafe')});
    error.name='MarketNativeArtifactPolicyError';
    const message=sensitivitySafeInstallError(error);
    const event=sanitiseInstallEvent({step:0,totalSteps:0,status:'error',message,detail:'secret=unsafe'});
    assert.equal(event.message,'Native app signature or checksum verification failed');
    assert.equal(JSON.stringify(event).includes('unsafe'),false);
  } finally {globalThis.fetch=originalFetch;policy.keys=originalKeys;await rm(root,{recursive:true,force:true});}
});
