import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOwnerTrust, ownerReleaseGrant, saveOwnerTrust, validateOwnerTrust, OWNER_TRUST_SCHEMA, type OwnerTrustPolicy } from '../src/lib/releases/owner-trust';
const key = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
const grant = {publisher:'Personal',repository:'https://forge.example/alice/App',branch:'main' as const,scope:'app' as const,public_key:key,revoked:false};
const url = `${grant.repository}/releases/download/v1.2.3/standalone.tar`;
test('publisher authority is exact source/channel/scope and revocation fails closed', () => {
 const policy: OwnerTrustPolicy = {schema:OWNER_TRUST_SCHEMA,grants:[grant]};
 validateOwnerTrust(policy);
 assert.equal(ownerReleaseGrant(url,'app',policy)?.publisher,'Personal');
 for(const scope of ['ui','cp','spine','appliance'] as const) assert.equal(ownerReleaseGrant(url,scope,policy),undefined);
 assert.equal(ownerReleaseGrant(url.replace('alice','bob'),'app',policy),undefined);
 assert.equal(ownerReleaseGrant(url.replace('/v1.2.3/','/dev-v1.2.3/'),'app',policy),undefined);
 assert.throws(()=>ownerReleaseGrant(url,'app',{...policy,grants:[{...grant,revoked:true}]}),/revoked/);
 assert.throws(()=>ownerReleaseGrant(url+'?key=replacement','app',policy),/exact/);
 assert.throws(()=>validateOwnerTrust({...policy,grants:[grant,grant]}),/Duplicate/);
 assert.throws(()=>validateOwnerTrust({...policy,grants:[{...grant,public_key:key+key}]}),/public key/);
});
test('durable policy survives reload and malformed policy does not disable checks', async()=>{
 const root=await mkdtemp(join(tmpdir(),'youeye-trust-'));const path=join(root,'trust.json');
 try {
  assert.deepEqual(loadOwnerTrust(path).grants,[]);
  await saveOwnerTrust({schema:OWNER_TRUST_SCHEMA,grants:[grant]},path);
  assert.equal(ownerReleaseGrant(url,'app',loadOwnerTrust(path))?.publisher,'Personal');
  assert.match(await readFile(path,'utf8'),/Personal/);
  await writeFile(path,'{}');assert.throws(()=>loadOwnerTrust(path),/Invalid/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('actual verifier rejects cross-scope, invalid and revoked custom signatures', async (t) => {
 const fs = await import('node:fs');
 const { syncBuiltinESMExports } = await import('node:module');
 const { createHash, sign } = await import('node:crypto');
 const { releaseArtifactTrust, verifySignedReleaseArtifactBuffer } = await import('../src/lib/releases/verify');
 const { OWNER_TRUST_PATH } = await import('../src/lib/releases/owner-trust');
 const pair = generateKeyPairSync('ed25519');
 const pem = pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const enrolled = {...grant,public_key:pem};
 const policy: OwnerTrustPolicy = {schema:OWNER_TRUST_SCHEMA,grants:[enrolled]};
 const original = fs.default.readFileSync;
 t.mock.method(fs.default, 'readFileSync', ((path: unknown, ...args: unknown[]) => {
  if (path === OWNER_TRUST_PATH) return Buffer.from(JSON.stringify(policy));
  return (original as (...args: unknown[]) => unknown)(path,...args);
 }) as typeof original);
 syncBuiltinESMExports();
 const artifact = Buffer.from('personal app');
 const hash = (b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const sums = Buffer.from(`${hash(artifact)}  standalone.tar\n${hash(Buffer.from(pem))}  release-development.pub\n${'0'.repeat(64)}  provenance.json\n${'1'.repeat(64)}  sbom.spdx.json\n`);
 let signature = sign(null,sums,pair.privateKey);
 t.mock.method(globalThis,'fetch',async (input:string|URL|Request)=>{
  const name = String(input).split('/').pop();
  return new Response(new Uint8Array(name==='release-development.pub'?Buffer.from(pem):name==='SHA256SUMS'?sums:signature));
 });
 try {
  assert.equal(releaseArtifactTrust(url,undefined,'app').class,'custom');
  assert.notEqual(releaseArtifactTrust(url,undefined,'ui').class,'custom');
  assert.throws(()=>releaseArtifactTrust(url),/explicit target scope/);
  assert.equal(await verifySignedReleaseArtifactBuffer(url,artifact,'standalone.tar',undefined,'app'),hash(artifact));
  await assert.rejects(verifySignedReleaseArtifactBuffer(url,artifact,'standalone.tar',undefined,'ui'),/trust anchor/);
  signature=Buffer.alloc(64);
  await assert.rejects(verifySignedReleaseArtifactBuffer(url,artifact,'standalone.tar',undefined,'app'),/signature/);
  enrolled.revoked=true;
  await assert.rejects(verifySignedReleaseArtifactBuffer(url,artifact,'standalone.tar',undefined,'app'),/revoked/);
 } finally {t.mock.restoreAll();syncBuiltinESMExports();}
});
