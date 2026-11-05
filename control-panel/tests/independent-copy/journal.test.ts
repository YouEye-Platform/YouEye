import {expect,test} from 'bun:test';
import {mkdtemp,rm,chmod,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withCopyJournal} from '../../src/lib/copy/journal';
test('copy journal survives a failed step and excludes a competing writer',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'youeye-copy-journal-'));
 try{
  await expect(withCopyJournal('copy-fixture','notes',async journal=>{
   expect(await journal.read()).toBeNull();await journal.write({phase:'prepared',fixture:'synthetic'});
   await expect(withCopyJournal('copy-fixture','notes',async()=>{},directory)).rejects.toThrow('busy');
   throw Error('interrupted fixture');
  },directory)).rejects.toThrow('interrupted fixture');
  await withCopyJournal('copy-fixture','notes',async journal=>expect(await journal.read()).toEqual({phase:'prepared',fixture:'synthetic'}),directory);
  const file=(await readdir(directory)).find(f=>f.endsWith('.json'))!;
  await chmod(join(directory,file),0o644);
  await expect(withCopyJournal('copy-fixture','notes',j=>j.read(),directory)).rejects.toThrow('unsafe');
  await rm(join(directory,file));await symlink('/dev/null',join(directory,file));
  await expect(withCopyJournal('copy-fixture','notes',j=>j.read(),directory)).rejects.toThrow('unreadable');
 }finally{await rm(directory,{recursive:true,force:true});}
});
