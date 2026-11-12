import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {AppUpdateExecutorLock} from '../market/update-executor-lock';

const root='/var/lib/youeye/state/independent-copies';
async function directory(path:string){
 await mkdir(path,{recursive:true,mode:0o700});
 const info=await lstat(path);
 if(!info.isDirectory()||info.uid!==process.geteuid?.()||(info.mode&0o777)!==0o700)throw Error('Native copy journal directory is unsafe');
}
async function syncDirectory(path:string){const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}}
/** Private local state can include newly generated authority, never returned by
 * a status endpoint. Callers validate the retained schema and exact request. */
export async function withCopyJournal<T>(requestId:string,component:string,work:(journal:{read:()=>Promise<unknown|null>;write:(value:unknown)=>Promise<void>})=>Promise<T>,directoryForTest=root):Promise<T>{
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(component))throw Error('Exact native copy journal identity required');
 await directory(directoryForTest);
 const id=createHash('sha256').update(requestId+'\0'+component).digest('hex');
 const file=join(directoryForTest,id+'.json');
 const lock=AppUpdateExecutorLock.acquire(join(directoryForTest,id+'.flock'));
 try{return await work({
  async read(){
   let input;try{input=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('Native copy journal is unreadable');}
   try{const info=await input.stat();if(!info.isFile()||info.uid!==process.geteuid?.()||(info.mode&0o777)!==0o600||info.size>1<<20||info.size===0)throw Error('Native copy journal is unsafe');return JSON.parse(await input.readFile('utf8')) as unknown;}finally{await input.close();}
  },
  async write(value){
   const payload=JSON.stringify(value);if(Buffer.byteLength(payload)>1<<20)throw Error('Native copy journal exceeds its bound');
   const temporary=join(directoryForTest,id+'.'+randomUUID()+'.tmp');
   try{const output=await open(temporary,'wx',0o600);try{await output.writeFile(payload);await output.sync();}finally{await output.close();}
    lock.assertHeld();await rename(temporary,file);await syncDirectory(directoryForTest);
   }finally{await rm(temporary,{force:true});}
  }
 });}finally{lock.release();}
}
