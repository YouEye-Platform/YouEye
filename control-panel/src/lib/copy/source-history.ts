import {constants,closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {appUpdateJournalStore,assertIndependentCopyLifecycle} from '../market/update-admission';
import {updateNeedsRecovery} from '../market/update-journal';

type NativeRequest=Parameters<typeof assertIndependentCopyLifecycle>[0];
/** Completed source update receipts remain inspectable provenance, outside the
 * destination's live recovery namespace. No checkpoint or ordinary data is
 * removed. An interrupted rename is reconciled from both exact directories. */
export function retainIndependentSourceHistory(request:NativeRequest){
 assertIndependentCopyLifecycle(request);
 const store=appUpdateJournalStore();
 return store.withAdmission(()=>{
  const records=store.list();
  if(records.some(updateNeedsRecovery))throw Error('Source app recovery must settle before copying');
  const operations=join(store.directory,'operations');
  if(readdirSync(operations).some(name=>!records.some(r=>name===r.id+'.json')))throw Error('Unknown source app update history requires reconciliation');
  const parent=join(store.directory,'copy-source-history'),destination=join(parent,request.request_id);
  mkdirSync(parent,{recursive:true,mode:0o700});privateDirectory(parent);
  try{privateDirectory(destination);if(records.length!==0)throw Error('Destination app history changed during source archival');}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   renameSync(operations,destination);
   mkdirSync(operations,{mode:0o700});
  }
  for(const path of [operations,parent,store.directory]){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
 });
}
function privateDirectory(path:string){const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.geteuid?.()||(s.mode&0o777)!==0o700)throw Error('Copy source history path is unsafe');}
