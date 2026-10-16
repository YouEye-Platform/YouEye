import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';
import { acceptProductSequence, productReceipt, verifyProductRelease, type ProductBuild, type ProductRelease } from '../src/lib/releases/product-release';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { withAppLifecycle } from '../src/lib/market/update-admission';
import { pointerRelease, readPointerReleaseState, savePointerReleaseState, updateIdenticalPointerRelease, type PointerReleaseIO, type PointerReleaseState } from '../src/lib/pointer/release-metadata';

const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
test('Pointer release-only transaction commits and recovers without payload or engine operations', async () => {
  const key = generateKeyPairSync('ed25519'), previous = publicPolicy.keys;
  publicPolicy.keys = {...previous,stable:key.publicKey.export({type:'spki',format:'pem'}).toString()};
  const root = await mkdtemp(join(tmpdir(),'youeye-pointer-label-'));
  try {
    const signer = sha(key.publicKey.export({type:'spki',format:'der'})), source = 'https://github.com/YouEye-Platform/Pointer';
    const build: ProductBuild = {schema:'youeye.product-build.v1',product:'pointer',kind:'native',build_version:'1.2.3',source,branch:'main',source_commit:'a'.repeat(40),tag:'v1.2.3',input_sha256:'b'.repeat(64),contract_sha256:'c'.repeat(64),signer_sha256:signer,primary:'standalone.tar',assets:['standalone.tar','SHA256SUMS','SHA256SUMS.sig','provenance.json','sbom.spdx.json'].map(name=>({name,url:`${source}/releases/download/v1.2.3/${name}`,sha256:sha(name),size_bytes:name.length}))};
    const buildRaw = Buffer.from(JSON.stringify(build));
    const release = (version: string, sequence: number) => {
      const r: ProductRelease = {schema:'youeye.product-release.v1',product:'pointer',version,source,branch:'main',tag:`v${version}`,channel:'stable',sequence,minimum_reader:1,signer_sha256:signer,build_manifest_base64:buildRaw.toString('base64'),build_signature_base64:sign(null,buildRaw,key.privateKey).toString('base64')};
      const raw = Buffer.from(JSON.stringify(r));
      return verifyProductRelease(raw,sign(null,raw,key.privateKey),{product:'pointer',source,tag:r.tag});
    };
    const original = release('1.2.3',3), next = release('1.2.4',4), later = release('1.2.5',5);
    const file = join(root,'pointer-release','installed.json'), store = new AppUpdateJournalStore(join(root,'journal'));
    const state: PointerReleaseState = {schema:'youeye.installed-pointer.v1',installed:{receipt:productReceipt(original),runtimeUUID:'12345678-1234-1234-1234-123456789abc'},floors:acceptProductSequence(undefined,original)};
    await savePointerReleaseState(state,file);
    let projection = structuredClone(state.installed!);
    let failPublication = false, replaced = false;
    const effects: string[] = [];
    const io: PointerReleaseIO = {
      read:()=>readPointerReleaseState(file),
      save:async s=>{effects.push('save');await savePointerReleaseState(s,file);},
      verify:async p=>{if(replaced) throw new Error('runtime replaced');assert.deepEqual(projection,p);},
      publish:async p=>{effects.push('publish');projection=structuredClone(p);if(failPublication){failPublication=false;throw new Error('lost projection acknowledgement');}},
      health:async()=>{effects.push('health');},
    };
    assert.equal(await withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,next,io),{store}),true);
    assert.equal(pointerRelease(await io.read())?.release.version,'1.2.4');
    assert.equal(store.list().filter(r=>r.commit && r.cleanupComplete).length,1);
    failPublication = true;
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,later,io),{store}),/lost projection acknowledgement/);
    assert.equal(pointerRelease(await io.read())?.release.version,'1.2.4');
    assert.equal(projection.receipt.manifestSHA256,next.manifestSHA256);
    assert.equal(Object.values((await io.read()).floors)[0].sequence,5);
    assert.equal(store.list().filter(r=>r.rollbackVerifiedAt && r.cleanupComplete).length,1);
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,next,io),{store}),/rollback/);
    replaced = true;
    const writes = effects.filter(e=>e === 'save' || e === 'publish').length;
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,later,io),{store}),/runtime replaced/);
    assert.equal(effects.filter(e=>e === 'save' || e === 'publish').length,writes);
    assert.ok(store.list().every(r=>r.resources.every(x=>!x.mutable || x.kind === 'metadata')));
  } finally { publicPolicy.keys = previous; await rm(root,{recursive:true,force:true}); }
});
