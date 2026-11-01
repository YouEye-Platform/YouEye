import {randomBytes} from 'node:crypto';
import {lstat,open,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';

export async function writeCopyAppSecret(appId:string,value:string,purpose:'jwt'|'database'='jwt'){
 if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)||!/^[a-f0-9]{96}$/.test(value))throw Error('Invalid native copy secret input');
 const dir=`/var/lib/youeye/app-${appId}`,path=`${dir}/${purpose==='jwt'?'.jwt_secret':'.db_password'}`,temporary=`${dir}/.copy-jwt-${randomBytes(16).toString('hex')}`;
 const info=await lstat(path);if(!info.isFile()||info.uid!==process.geteuid?.()||(info.mode&0o777)!==0o600)throw Error('Copied app secret path is unsafe');
 try{
  const file=await open(temporary,'wx',0o600);try{await file.writeFile(value);await file.sync();}finally{await file.close();}
  await rename(temporary,path);const parent=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
 }finally{await rm(temporary,{force:true});}
}
