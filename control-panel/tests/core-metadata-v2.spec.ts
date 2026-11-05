import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metadataFromExecution, metadataSourceBindings, normalizedMetadataJSON, verifyCoreMetadataProof, type CoreMetadataProof } from '../src/lib/releases/core-metadata';
import { loadSelectedCoreDocument, parseCoreRelease, selectedCoreArtifact, selectedCoreTransportURL, verifyCoreMetadataForOperation } from '../src/lib/releases/core-release';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';

const vector = JSON.parse(readFileSync(new URL('../../releasecache/testdata/core-metadata-v2-vector.json', import.meta.url), 'utf8'));
const execution = Buffer.from(vector.execution, 'base64'), signature = Buffer.from(vector.execution_signature, 'base64');
const key = createPublicKey(vector.public_key);
const privateKey = createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,19)]),format:'der',type:'pkcs8'});
const sha = (raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const cloneProof = () => structuredClone(vector.proof) as CoreMetadataProof;

function rebuilt(input: { publicOnly?:boolean; capabilities?:string[]; canonical?:(raw:string)=>string; legacy?:boolean; legacyUITag?:boolean } = {}) {
  const release=parseCoreRelease(execution), proof=cloneProof();
  if(input.publicOnly)for(const member of release.members){member.source=release.source;member.branch='main';for(const field of ['artifact','checksums','signature','provenance','sbom','document_signature','release_lock'] as const){const blob=member[field];if(blob)blob.url=`${member.source}/releases/download/${member.tag}/${blob.name}`;}}
  if(input.legacyUITag){const member=release.members.find(member=>member.role==='ui')!;member.tag='ui-v0.5.37';for(const blob of [member.artifact,member.checksums,member.signature,member.provenance,member.sbom])blob.url=`${member.source}/releases/download/${member.tag}/${blob.name}`;}
  if(input.capabilities)release.compatibility.capabilities=input.capabilities;
  if(input.legacy){
    const spine=release.members.find(member=>member.role==='spine')!;
    const provenance=Buffer.from('{"schema":"legacy-provenance"}\n');
    spine.provenance.sha256=sha(provenance);spine.provenance.size_bytes=provenance.length;
    const sums=Buffer.from([spine.artifact,spine.provenance,spine.sbom].map(blob=>`${blob.sha256}  ${blob.name}\n`).join(''));
    const sig=sign(null,sums,privateKey);spine.checksums.sha256=sha(sums);spine.checksums.size_bytes=sums.length;spine.signature.sha256=sha(sig);spine.signature.size_bytes=sig.length;
    proof.spine_checksums=sums.toString('base64');proof.spine_signature=sig.toString('base64');proof.spine_provenance=provenance.toString('base64');
  }
  const raw=Buffer.from(JSON.stringify(release)), sig=sign(null,raw,privateKey);
  proof.execution_manifest_sha256=sha(raw);
  const metadata=metadataFromExecution(release);
  const canonical=Buffer.from(input.canonical?.(normalizedMetadataJSON(metadata).toString()) ?? normalizedMetadataJSON(metadata));
  const pair=Buffer.from(JSON.stringify({schema:'youeye.core-metadata-pair.v1',source_id:metadata.publisher.id,branch:release.branch,sequence:release.sequence,
    execution_manifest_sha256:sha(raw),canonical_manifest_sha256:sha(canonical),normalized_identity_sha256:sha(normalizedMetadataJSON(metadata)),signer_sha256:release.signer_sha256})+'\n');
  proof.documents={canonical:canonical.toString('base64'),canonical_signature:sign(null,canonical,privateKey).toString('base64'),pair:pair.toString('base64'),pair_signature:sign(null,pair,privateKey).toString('base64')};
  proof.bindings=metadataSourceBindings(release);
  return {release,raw,sig,proof};
}

test('the independent Go signed vector preserves exact execution digest and address-free canonical identity',()=>{
  assert.equal(createPublicKey(privateKey).export({format:'pem',type:'spki'}),vector.public_key);
  assert.deepEqual(verifyCoreMetadataProof(execution,signature,cloneProof(),key,()=>key),vector.facts);
  const canonical=Buffer.from(vector.proof.documents.canonical,'base64');
  assert.equal(canonical.includes(Buffer.from('://')),false);
  assert.equal(sha(normalizedMetadataJSON(metadataFromExecution(parseCoreRelease(execution)))) ,vector.facts.normalized_identity_sha256);
  assert.equal(vector.facts.execution_manifest_sha256,sha(execution));
  assert.notEqual(vector.facts.execution_manifest_sha256,vector.facts.canonical_manifest_sha256);
  assert.equal(normalizedMetadataJSON({text:'<>&\u2028\u2029'}).toString(),'{"text":"\\u003c\\u003e\\u0026\\u2028\\u2029"}\n');
});

test('all current original role authorities are independent of signed asserted classes and source IDs',()=>{
  const other=generateKeyPairSync('ed25519').publicKey;
  assert.throws(()=>verifyCoreMetadataProof(execution,signature,cloneProof(),key,member=>member.role==='cp'?other:key),/role authority/);
  const proof=cloneProof();proof.bindings![12].original_source='https://other.example.test/team/YouEye';
  assert.throws(()=>verifyCoreMetadataProof(execution,signature,proof,key,()=>key),/registry/);
});

test('signed Spine capability prevents stripped, partial, swapped and changed pairs from downgrading',()=>{
  for(const docs of [{canonical:null,canonical_signature:null,pair:null,pair_signature:null},{...cloneProof().documents,pair_signature:null}]){
    const proof=cloneProof();proof.advertised=false;proof.documents=docs;proof.bindings=null;
    assert.throws(()=>verifyCoreMetadataProof(execution,signature,proof,key,()=>key),/partial paired/);
  }
  const changed=cloneProof();changed.execution_manifest_sha256='0'.repeat(64);
  assert.throws(()=>verifyCoreMetadataProof(execution,signature,changed,key,()=>key),/exact execution/);
  const swapped=cloneProof();swapped.documents.pair_signature=swapped.documents.canonical_signature;
  assert.throws(()=>verifyCoreMetadataProof(execution,signature,swapped,key,()=>key),/pair/);
});

test('semantic URL escapes, duplicate signed fields and non-integer wire tokens fail closed',()=>{
  const badTag=JSON.parse(execution.toString());
  const member=badTag.members.find((value:{role:string})=>value.role==='cp');member.tag=7;
  for(const field of ['artifact','checksums','signature','provenance','sbom'])member[field].url=`${member.source}/releases/download/7/${member[field].name}`;
  assert.throws(()=>parseCoreRelease(Buffer.from(JSON.stringify(badTag))),/Invalid core member/);
  for(const canonical of [
    (raw:string)=>raw.replace('"minimum_metadata_reader":2','"minimum_metadata_reader":2.0'),
    (raw:string)=>raw.replace('"minimum_metadata_reader":2','"minimum_metadata_reader":2,"minimum_metadata_reader":2'),
  ]){const f=rebuilt({canonical});assert.throws(()=>verifyCoreMetadataProof(f.raw,f.sig,f.proof,key,()=>key));}
  const escaped=rebuilt({capabilities:['core-release-v1','https://example.test/path'],canonical:raw=>raw.replaceAll('https://','https:\\/\\/')});
  assert.throws(()=>verifyCoreMetadataProof(escaped.raw,escaped.sig,escaped.proof,key,()=>key),/Canonical identity/);
  const formatted=rebuilt({canonical:raw=>JSON.stringify(JSON.parse(raw),null,2)+'\n'});
  const facts=verifyCoreMetadataProof(formatted.raw,formatted.sig,formatted.proof,key,()=>key);
  assert.equal(facts.execution_manifest_sha256,sha(formatted.raw));
  assert.equal(facts.normalized_identity_sha256,sha(normalizedMetadataJSON(metadataFromExecution(formatted.release))));
});

test('protected selected proofs fail closed on malformed sidecars and do not replace the exact execution digest',async()=>{
  const f=rebuilt({publicOnly:true}), root=mkdtempSync(join(tmpdir(),'youeye-core-v2-'));
  const saved=publicPolicy.keys;publicPolicy.keys={stable:vector.public_key};
  try{
    for(const [name,raw] of [['core-release.json',f.raw],['core-release.json.sig',f.sig],['core-metadata.json',Buffer.from(JSON.stringify(f.proof))]] as const)writeFileSync(join(root,name),raw,{mode:0o600});
    const selected=loadSelectedCoreDocument(root);
    assert.equal(selected.manifestSHA256,sha(f.raw));assert.equal(selected.metadataFacts?.schema,'youeye.core-metadata.v2');
    writeFileSync(join(root,'core-metadata.json'),'{"schema":"broken"}');
    assert.throws(()=>loadSelectedCoreDocument(root));
    // Old selections lacking sidecars still have to authenticate the original
    // Spine marker at operation time; missing publication cannot imply legacy.
    const target={...selected,metadataProof:undefined,member:f.release.members.find(member=>member.role==='ui')!,key};
    const read:typeof fetch=async(input)=>{
      const url=String(input), spine=f.release.members.find(member=>member.role==='spine')!;
      for(const [field,encoded] of [['checksums',f.proof.spine_checksums],['signature',f.proof.spine_signature],['provenance',f.proof.spine_provenance]] as const)if(url===spine[field].url)return new Response(Buffer.from(encoded,'base64'));
      return new Response('missing',{status:404});
    };
    await assert.rejects(verifyCoreMetadataForOperation(target,read),/partial canonical/);
    const legacy=rebuilt({publicOnly:true,legacy:true});legacy.proof.advertised=false;legacy.proof.bindings=null;legacy.proof.documents={canonical:null,canonical_signature:null,pair:null,pair_signature:null};
    assert.equal(verifyCoreMetadataProof(legacy.raw,legacy.sig,legacy.proof,key,()=>key).schema,'youeye.core-release.v1');
  }finally{publicPolicy.keys=saved;rmSync(root,{recursive:true,force:true});}
});

test('reused original component tags remain bound to Core identity and exact scoped mirror transport',()=>{
  const f=rebuilt({publicOnly:true,legacyUITag:true}), root=mkdtempSync(join(tmpdir(),'youeye-core-legacy-tag-'));
  const saved=publicPolicy.keys;publicPolicy.keys={stable:vector.public_key};
  try{
    for(const [name,raw] of [['core-release.json',f.raw],['core-release.json.sig',f.sig],['core-metadata.json',Buffer.from(JSON.stringify(f.proof))]] as const)writeFileSync(join(root,name),raw,{mode:0o600});
    const ui=f.release.members.find(member=>member.role==='ui')!;
    assert.equal(selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root)?.member.tag,'ui-v0.5.37');
    assert.throws(()=>selectedCoreArtifact(ui.artifact.url,'0'.repeat(64),'ui',root),/frozen core/);
    assert.equal(selectedCoreTransportURL(ui.artifact.url,true,root),`${f.release.source}/releases/download/${f.release.tag}/blob-${ui.artifact.sha256}`);
    assert.equal(selectedCoreTransportURL(ui.artifact.url,false,root),ui.artifact.url);
  }finally{publicPolicy.keys=saved;rmSync(root,{recursive:true,force:true});}
});
