import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appUpdateJournalStore,withIndependentCopyLifecycle} from '../../src/lib/market/update-admission';
import {retainIndependentSourceHistory} from '../../src/lib/copy/source-history';
test('source history survives archival and a lost acknowledgement outside live destination recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'copy-history-')),prior=process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
 process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR=root;
 const request={request_id:'copy-history',source_hardware:'smbios:11111111-1111-1111-1111-111111111111',destination_hardware:'smbios:22222222-2222-2222-2222-222222222222',source_receipt_sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64)};
 try{
  const store=appUpdateJournalStore();
  const hash='a'.repeat(64);
  const lease=store.create({appId:'notes',source:{manifestSHA256:hash,artifactSHA256:[hash]},target:{manifestSHA256:hash,artifactSHA256:[hash]},resources:[{kind:'app',scope:'market',name:'notes',ownerAppId:'notes',mutable:false}],originalRunning:{},metadataBeforeSHA256:hash});
  const id=lease.snapshot().id;lease.release();
  writeFileSync(join(root,'copy-reservation.json'),JSON.stringify({schema:'youeye.copy-lifecycle.v1',role:'destination',request}),{mode:0o600});
  await expect(withIndependentCopyLifecycle(request,async()=>retainIndependentSourceHistory(request))).rejects.toThrow('settle');
  const recovered=store.recover(id);recovered.transition('recovering');recovered.rolledBack();recovered.transition('cleanup');recovered.finishCleanup();recovered.release();
  const original=readFileSync(join(root,'operations',id+'.json'),'utf8');
  // Simulate process loss after the durable rename and before mkdir/fsync.
  mkdirSync(join(root,'copy-source-history'),{mode:0o700});renameSync(join(root,'operations'),join(root,'copy-source-history',request.request_id));
  await withIndependentCopyLifecycle(request,async()=>retainIndependentSourceHistory(request));
  expect(store.list()).toEqual([]);
  expect(readFileSync(join(root,'copy-source-history',request.request_id,id+'.json'),'utf8')).toBe(original);
  await withIndependentCopyLifecycle(request,async()=>retainIndependentSourceHistory(request));
  expect(readdirSync(join(root,'operations'))).toEqual([]);
  writeFileSync(join(root,'operations','unknown'),'',{mode:0o600});
  await expect(withIndependentCopyLifecycle(request,async()=>retainIndependentSourceHistory(request))).rejects.toThrow('Unknown');
 }finally{if(prior===undefined)delete process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;else process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR=prior;rmSync(root,{recursive:true,force:true});}
});
