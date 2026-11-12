import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptProductSequence, productReceipt, productTag, verifyProductRelease } from '../src/lib/releases/product-release';
import { productFixture } from './fixtures/release-fixtures';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { withAppLifecycle } from '../src/lib/market/update-admission';
import { pointerRelease, readPointerReleaseState, savePointerReleaseState, updateIdenticalPointerRelease, type PointerReleaseIO, type PointerReleaseState } from '../src/lib/pointer/release-metadata';

test('Pointer release-only transaction commits and recovers without payload or engine operations', async () => {
  const root = await mkdtemp(join(tmpdir(),'youeye-pointer-label-'));
  try {
    const repository = 'https://github.com/YouEye-Platform/Pointer';
    const base = productFixture('pointer','1.2.3-dev.1',repository,{'standalone.tar':Buffer.from('standalone.tar'),'pointer-build-contract.json':Buffer.from('contract')});
    // One build, renamed by its promotions (no rebuild).
    const release = (version: string, sequence: number) => {
      const r = {...base.release,version,tag:productTag('pointer',version),sequence};
      return verifyProductRelease(Buffer.from(JSON.stringify(r)),{product:'pointer',repository,tag:r.tag});
    };
    const original = release('1.2.3-dev.1',3), next = release('1.2.3-alpha.1',4), later = release('1.2.3-beta.1',5);
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
    assert.equal(pointerRelease(await io.read())?.release.version,'1.2.3-alpha.1');
    assert.equal(store.list().filter(r=>r.commit && r.cleanupComplete).length,1);
    failPublication = true;
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,later,io),{store}),/lost projection acknowledgement/);
    assert.equal(pointerRelease(await io.read())?.release.version,'1.2.3-alpha.1');
    assert.equal(projection.receipt.manifestSHA256,next.manifestSHA256);
    // The floor keeps the accepted build; the installed document stays as recovered.
    assert.deepEqual((await io.read()).floors.pointer,{build:'1.2.3-dev.1',buildSHA256:state.floors.pointer.buildSHA256,manifestSHA256:later.manifestSHA256});
    assert.equal(store.list().filter(r=>r.rollbackVerifiedAt && r.cleanupComplete).length,1);
    // Another name of the same build (e.g. the box changed channel back) is a label update, never "older".
    assert.equal(await withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,original,io),{store}),true);
    assert.equal(pointerRelease(await io.read())?.release.version,'1.2.3-dev.1');
    // An older build is refused whatever its name.
    const olderBuild = productFixture('pointer','1.2.3',repository,{'standalone.tar':Buffer.from('older'),'pointer-build-contract.json':Buffer.from('contract')},{build:'1.2.2-dev.7'});
    assert.throws(()=>acceptProductSequence(state.floors,verifyProductRelease(olderBuild.raw,{product:'pointer',repository,tag:olderBuild.tag})),/older pointer build/);
    replaced = true;
    const writes = effects.filter(e=>e === 'save' || e === 'publish').length;
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,later,io),{store}),/runtime replaced/);
    assert.equal(effects.filter(e=>e === 'save' || e === 'publish').length,writes);
    assert.ok(store.list().every(r=>r.resources.every(x=>!x.mutable || x.kind === 'metadata')));
  } finally { await rm(root,{recursive:true,force:true}); }
});
