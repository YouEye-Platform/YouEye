import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';
import test from 'node:test';
import { releaseArtifactTrust, signedReleaseVerificationShell, verifySignedReleaseArtifactBuffer } from '../src/lib/releases/verify';

const key = () => generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
test('public component trust selects a provisioned channel and never falls back to development', () => {
  const policy = {schema:'youeye.public-trust.v1',keys:{stable:key(),beta:key()}};
  const base='https://github.com/YouEye-Platform/YouEye/releases/download/';
  assert.equal(releaseArtifactTrust(base+'ui-v0.5.5/standalone.tar',policy).pem,policy.keys.stable);
  assert.equal(releaseArtifactTrust(base+'ui-beta-v0.5.5/standalone.tar',policy).pem,policy.keys.beta);
  assert.equal(releaseArtifactTrust(base+'ui-v0.5.5/standalone.tar',policy).name,'release-public.pub');
  for (const url of [base+'ui-dev-v0.5.5/standalone.tar',base+'ui-v0.5.5/standalone.tar?x=1',base.replace('https:','http:')+'ui-v0.5.5/standalone.tar']) assert.throws(()=>releaseArtifactTrust(url,policy));
  assert.throws(()=>releaseArtifactTrust(base+'ui-v0.5.5/standalone.tar',{schema:'youeye.public-trust.v1',keys:{}}));
});
test('private release shell retains development signatures and digest checking', () => {
  const shell=signedReleaseVerificationShell('https://forge.example.test/a/b/releases/download/ui-dev-v1.0.0/standalone.tar','/tmp/app.tar','a'.repeat(64));
  assert.match(shell,/release-development.pub/);
  assert.match(shell,/openssl pkeyutl -verify/);
  assert.match(shell,/sha256sum/);
});

test('public artifact verification checks the pinned key, signature and artifact digest', async () => {
  const pair=generateKeyPairSync('ed25519');
  const pem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  const policy=publicPolicy as {schema:string;keys:Record<string,string>};
  const originalKeys=policy.keys; const originalFetch=globalThis.fetch;
  const bytes=Buffer.from('test public component');
  const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
  const sums=Buffer.from(`${sha(bytes)}  standalone.tar\n${sha(pem)}  release-public.pub\n${'1'.repeat(64)}  provenance.json\n${'2'.repeat(64)}  sbom.spdx.json\n`);
  let signature=sign(null,sums,pair.privateKey);
  policy.keys={stable:pem};
  globalThis.fetch=async (input) => {
    const name=new URL(String(input)).pathname.split('/').at(-1);
    if(name==='release-public.pub') return new Response(pem);
    if(name==='SHA256SUMS') return new Response(sums);
    if(name==='SHA256SUMS.sig') return new Response(signature);
    return new Response('',{status:404});
  };
  const url='https://github.com/YouEye-Platform/YouEye/releases/download/ui-v0.5.5/standalone.tar';
  try {
    assert.equal(await verifySignedReleaseArtifactBuffer(url,bytes,'standalone.tar',sha(bytes)),sha(bytes));
    const pointerURL='https://github.com/YouEye-Platform/Pointer/releases/download/v0.5.1/standalone.tar';
    assert.equal(await verifySignedReleaseArtifactBuffer(pointerURL,bytes,'standalone.tar',sha(bytes)),sha(bytes));
    await assert.rejects(verifySignedReleaseArtifactBuffer(pointerURL,Buffer.from('tampered')),/signed checksum/);
    await assert.rejects(verifySignedReleaseArtifactBuffer(url,Buffer.from('tampered'),'standalone.tar',sha(bytes)),/signed checksum/);
    signature=Buffer.alloc(64);
    await assert.rejects(verifySignedReleaseArtifactBuffer(url,bytes),/signature is invalid/);
  } finally {policy.keys=originalKeys;globalThis.fetch=originalFetch;}
});


test('official Pointer tags use public stable or beta trust without widening other repositories', () => {
  const policy = {schema:'youeye.public-trust.v1',keys:{stable:key(),beta:key()}};
  const base = 'https://github.com/YouEye-Platform/Pointer/releases/download/';
  assert.equal(releaseArtifactTrust(base+'v0.5.1/standalone.tar',policy).pem, policy.keys.stable);
  assert.equal(releaseArtifactTrust(base+'beta-v0.5.1/standalone.tar',policy).pem, policy.keys.beta);
  for (const url of [
    base+'dev-v0.5.1/standalone.tar',
    base+'cp-v0.5.1/standalone.tar',
    base.replace('/Pointer/', '/YouEye/')+'v0.5.1/standalone.tar',
    base.replace('/YouEye-Platform/', '/unrelated/')+'v0.5.1/standalone.tar',
    base+'v0.5.1/standalone.tar?channel=stable',
  ]) assert.throws(() => releaseArtifactTrust(url,policy));
});
