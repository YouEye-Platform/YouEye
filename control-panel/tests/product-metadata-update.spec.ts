import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import policy from '../../spine/internal/systemupdate/public-release-trust.json';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { AppUpdateTransaction } from '../src/lib/market/update-transaction';
import { ReleaseMetadataUpdateProvider, updateIdenticalProductRelease, type ReleaseMetadataIO } from '../src/lib/market/update-release-metadata';
import { productReceipt, verifyProductRelease, acceptProductSequence, type ProductBuild, type ProductRelease } from '../src/lib/releases/product-release';
import type { AppManifest, InstallMetadata } from '../src/lib/market/types';
import type { InstalledApp } from '../src/lib/market/installed-apps';

const hash = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
test('release-only adoption and ambiguous publication recovery use the durable journal', async t => {
  const key = generateKeyPairSync('ed25519'), previousKeys = policy.keys;
  policy.keys = {...previousKeys,stable:key.publicKey.export({type:'spki',format:'pem'}).toString()};
  const source = 'https://github.com/YouEye-Platform/Notes', signer = hash(key.publicKey.export({type:'spki',format:'der'}));
  const build: ProductBuild = {schema:'youeye.product-build.v1',product:'notes',kind:'native',build_version:'1.0.0',source,branch:'main',source_commit:'a'.repeat(40),tag:'v1.0.0',input_sha256:'b'.repeat(64),contract_sha256:'c'.repeat(64),signer_sha256:signer,primary:'standalone.tar',assets:[]};
  build.assets = ['standalone.tar','SHA256SUMS','SHA256SUMS.sig','provenance.json','sbom.spdx.json'].map(name => ({name,url:`${source}/releases/download/v1.0.0/${name}`,sha256:hash(name),size_bytes:name.length}));
  const buildRaw = Buffer.from(JSON.stringify(build));
  function release(version: string, sequence: number) {
    const r: ProductRelease = {schema:'youeye.product-release.v1',product:'notes',version,source,branch:'main',tag:`v${version}`,channel:'stable',sequence,minimum_reader:1,signer_sha256:signer,build_manifest_base64:buildRaw.toString('base64'),build_signature_base64:sign(null,buildRaw,key.privateKey).toString('base64')};
    const raw = Buffer.from(JSON.stringify(r));
    return verifyProductRelease(raw,sign(null,raw,key.privateKey),{product:'notes',source,tag:r.tag});
  }
  const old = release('1.0.0',1), selected = release('1.0.1',2);
  const oldManifest = {metadata:{id:'notes'},version:'1.0.0',containers:[{name:'server',type:'lxd'}]} as AppManifest;
  const manifest = {...oldManifest,version:'1.0.1'};
  try {
    for (const fault of ['none','projection','manifest','metadata','provenance','verification']) await t.test(fault,async () => {
      const root = mkdtempSync(path.join(tmpdir(),'ye-product-adoption-'));
      const store = new AppUpdateJournalStore(root);
      const before = {appId:'notes',installedVersion:'1.0.0',serviceCredentialState:'ready',domain:'old.test',
        containers:[{name:'server',containerName:'app-notes',type:'lxd'}],
        nativeArtifacts:[{containerName:'server',sourceRepo:source,releaseTag:'v1.0.0',version:'1.0.0',artifactName:'standalone.tar',sha256:hash('standalone.tar'),bytes:14,signature:'verified',productRelease:productReceipt(old),runtimeUUID:'12345678-1234-1234-1234-123456789012'}],
        productReleaseFloors:acceptProductSequence(undefined,old)} as InstallMetadata;
      let metadata = structuredClone(before);
      const installed = {installedVersion:'1.0.0',installedTag:'v1.0.0',installedBranch:'main',channelSource:source,updateAvailable:true, catalogVersion:'1.0.1', switchPending:false, candidateVersion:'1.0.1', candidateBranch:'main',candidateTag:'v1.0.1'} as InstalledApp;
      const originalInstalled = structuredClone(installed);
      let registration = structuredClone(oldManifest), projection = productReceipt(old), faulted = false;
      const effects: string[] = [];
      function after(name: string) {
        effects.push(name);
        if (fault === name && !faulted) { faulted = true; throw Error(`ambiguous ${name}`); }
      }
      const io: ReleaseMetadataIO = {
        metadata:async()=>structuredClone(metadata),save:async m=>{metadata=structuredClone(m);after('metadata');},
        installed:async()=>structuredClone(installed),restoreInstalled:async(_,state)=>{Object.assign(installed,state);},
        provenance:async(_,s)=>{Object.assign(installed,{installedVersion:s.release.version,installedTag:s.release.tag,installedBranch:s.release.branch,channelSource:s.release.source,updateAvailable:false});after('provenance');},
        manifest:async()=>structuredClone(registration),syncManifest:async(_,m)=>{registration=structuredClone(m);after('manifest');},
        verifyProjection:async p=>{assert.deepEqual(projection,p.receipt);if(p.receipt.manifestSHA256===selected.manifestSHA256)after('verification');},
        publishProjection:async p=>{projection=structuredClone(p.receipt);metadata.domain='current-owner.test';after('projection');},
        health:async()=>{effects.push('health');},
      };
      try {
        const operation = updateIdenticalProductRelease(store,before,installed,manifest,selected,
          {path:'youeye-app.yaml',repo:'YouEye-Platform/Notes',branch:'v1.0.1',digest:`sha256:${build.contract_sha256}`},io);
        if (fault === 'none') {
          assert.deepEqual(await operation,{success:true,previousVersion:'1.0.0',newVersion:'1.0.1',migrationsRun:0});
          assert.deepEqual(projection,productReceipt(selected));
          assert.equal(metadata.installedVersion,'1.0.1');
        } else {
          await assert.rejects(operation,/ambiguous/);
          assert.deepEqual(projection,productReceipt(old));
          assert.equal(metadata.installedVersion,'1.0.0');
          assert.deepEqual(installed,originalInstalled);
          assert.deepEqual(registration,oldManifest);
        }
        assert.equal(metadata.domain,'current-owner.test','current owner configuration survives apply and recovery');
        const journal = store.list()[0];
        assert.equal(journal.operationKind,'release-metadata');
        assert.equal(journal.cleanupComplete,true);
        assert.equal(!!journal.commit,fault==='none');
        assert.equal(journal.checkpoints.length,1);
        assert.equal(journal.checkpoints[0].method,'scoped-metadata');
        assert.ok(journal.resources.every(r=>!r.mutable || r.kind==='metadata'));
        assert.equal(store.isReserved(journal.resources[0]),false);
        if (['none','metadata','provenance','verification'].includes(fault)) {
          assert.throws(()=>acceptProductSequence(metadata.productReleaseFloors,old),/rollback/);
        }
      } finally { rmSync(root,{recursive:true,force:true}); }
    });
    await t.test('interruption before recovery initialization has no payload effects',async()=>{
      const root = mkdtempSync(path.join(tmpdir(),'ye-product-admission-'));
      try {
        const store = new AppUpdateJournalStore(root);
        const lease = store.create({appId:'notes',operationKind:'release-metadata',resources:[{kind:'app',scope:'market',name:'notes',ownerAppId:'notes',mutable:false},{kind:'metadata',scope:'market',name:'notes',ownerAppId:'notes',mutable:true}],originalRunning:{},metadataBeforeSHA256:'a'.repeat(64),source:{manifestSHA256:'b'.repeat(64),artifactSHA256:[]},target:{manifestSHA256:'c'.repeat(64),artifactSHA256:[]}});
        lease.intent('initialize-recovery-plan');
        const id = lease.snapshot().id; lease.release();
        await store.withExecutor(id,async recovered=>new AppUpdateTransaction(recovered,new ReleaseMetadataUpdateProvider(root)).recover());
        assert.equal(store.read(id).cleanupComplete,true);
      } finally { rmSync(root,{recursive:true,force:true}); }
    });
  } finally { policy.keys = previousKeys; }
});
