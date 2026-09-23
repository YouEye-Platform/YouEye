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
