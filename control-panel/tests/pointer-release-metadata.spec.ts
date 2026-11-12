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
    const base = productFixture('pointer','1.2.3',repository,{'standalone.tar':Buffer.from('standalone.tar'),'pointer-build-contract.json':Buffer.from('contract')});
    // One build, relabelled by later releases (promotion without rebuild).
    const release = (version: string, sequence: number) => {
      const r = {...base.release,version,tag:productTag('pointer',version),sequence};
      return verifyProductRelease(Buffer.from(JSON.stringify(r)),{product:'pointer',repository,tag:r.tag});
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
    assert.equal((await io.read()).floors.pointer.sequence,5);
    assert.equal(store.list().filter(r=>r.rollbackVerifiedAt && r.cleanupComplete).length,1);
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,next,io),{store}),/older pointer release/);
    replaced = true;
    const writes = effects.filter(e=>e === 'save' || e === 'publish').length;
    await assert.rejects(withAppLifecycle('pointer',()=>updateIdenticalPointerRelease(store,later,io),{store}),/runtime replaced/);
    assert.equal(effects.filter(e=>e === 'save' || e === 'publish').length,writes);
    assert.ok(store.list().every(r=>r.resources.every(x=>!x.mutable || x.kind === 'metadata')));
  } finally { await rm(root,{recursive:true,force:true}); }
});
