import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {withAppLifecycle,withIndependentCopyLifecycle,withIndependentCopyExclusion,assertIndependentCopyLifecycle,appUpdateJournalStore} from '../../src/lib/market/update-admission';

test('only the exact native destination context enters copied app lifecycle reservations',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'copy-lifecycle-'));
 const previous=process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
 process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR=directory;
 try{
   appUpdateJournalStore();
   const request={request_id:'copy-test',source_hardware:'smbios:11111111-1111-1111-1111-111111111111',destination_hardware:'smbios:22222222-2222-2222-2222-222222222222',source_receipt_sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64)};
   const write=(role:string)=>writeFileSync(path.join(directory,'copy-reservation.json'),JSON.stringify({schema:'youeye.copy-lifecycle.v1',role,request}),{mode:0o600});
   write('source');
   let sent=false;
   await expect(withIndependentCopyExclusion(async()=>{sent=true;})).rejects.toThrow('independent copy');
   expect(sent).toBe(false);
   await expect(withAppLifecycle('fixture',async()=>true)).rejects.toThrow('independent copy');
   await expect(withIndependentCopyLifecycle(request,async()=>true)).rejects.toThrow('destination');
   write('destination');
   await expect(withIndependentCopyExclusion(async()=>{sent=true;})).rejects.toThrow('independent copy');
   expect(await withIndependentCopyLifecycle(request,()=>withIndependentCopyExclusion(async()=>true))).toBe(true);
   await expect(withAppLifecycle('fixture',async()=>true)).rejects.toThrow('independent copy');
   expect(()=>assertIndependentCopyLifecycle(request)).toThrow('context');
   expect(await withIndependentCopyLifecycle(request,()=>withAppLifecycle('fixture',async()=>{assertIndependentCopyLifecycle(request);return true;}))).toBe(true);
   await expect(withIndependentCopyLifecycle({...request,request_id:'different'},async()=>true)).rejects.toThrow('reservation');
   await expect(withAppLifecycle('fixture',async()=>true)).rejects.toThrow('independent copy');
 }finally{if(previous===undefined)delete process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;else process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR=previous;rmSync(directory,{recursive:true,force:true});}
});
