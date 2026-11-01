import {afterAll,beforeAll,expect,mock,test} from 'bun:test';
const enabled=process.env.YOUEYE_COPY_DB_FIXTURE==='1';
const run=enabled?test:test.skip;
let db:any,copy:any,written='';
const app={appId:'notes',database:{name:'copy_notes',role:'copy_notes'}} as any;
beforeAll(async()=>{
 if(!enabled)return;
 if(!process.env.DATABASE_URL?.includes('/crew_environment_fixture'))throw Error('Disposable database fixture required');
 db=new Bun.SQL(process.env.DATABASE_URL!);
 await db.unsafe("CREATE ROLE copy_notes LOGIN PASSWORD 'fixture-old'");
 await db.unsafe('CREATE DATABASE copy_notes OWNER copy_notes');
 const data=new Bun.SQL(process.env.DATABASE_URL!.replace('/crew_environment_fixture','/copy_notes'));
 await data.unsafe("CREATE TABLE retained_data(id uuid PRIMARY KEY,value text); ALTER TABLE retained_data OWNER TO copy_notes; INSERT INTO retained_data VALUES('11111111-1111-1111-1111-111111111111','retained'); GRANT SELECT ON retained_data TO PUBLIC").simple();
 await data.close();
 mock.module('../../src/lib/incus/server',()=>({execCommand:async(_container:string,args:string[],options:any)=>{
  // Only transport is substituted: execute the actual native SQL with a real
  // disposable PostgreSQL server and SCRAM-authenticated role connection.
  const argv=[...args];const user=argv.indexOf('-U');if(argv[user+1]==='youeye')argv[user+1]=process.env.USER||'alex';
  if(!argv.includes('-h'))argv.push('-h',process.env.COPY_FIXTURE_SOCKET!);
  argv.push('-p','55439');
  const proc=Bun.spawn(argv,{env:{...process.env,...options?.environment},stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,exitCode]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);return {stdout,stderr,exitCode};
 }}));
 mock.module('../../src/lib/copy/app-secret',()=>({writeCopyAppSecret:async(_id:string,password:string,purpose:string)=>{expect(purpose).toBe('database');written=password;}}));
 copy=await import('../../src/lib/copy/app-database');
});
afterAll(async()=>{if(db)await db.close();});
run('copy changes only the recorded app role password, authenticates it, and preserves database data and grants',async()=>{
 const before=await db.unsafe("SELECT datdba::text,datacl::text FROM pg_database WHERE datname='copy_notes'");
 const secret='b'.repeat(96);
 await copy.prepareCopyAppDatabase(app,secret);expect(written).toBe(secret);
 await copy.prepareCopyAppDatabase(app,secret);
 expect(await db.unsafe("SELECT datdba::text,datacl::text FROM pg_database WHERE datname='copy_notes'")).toEqual(before);
 const data=new Bun.SQL(`postgresql://copy_notes:${secret}@127.0.0.1:55439/copy_notes`);
 expect(await data.unsafe('SELECT id::text,value FROM retained_data')).toEqual([{id:'11111111-1111-1111-1111-111111111111',value:'retained'}]);
 expect((await data.unsafe("SELECT has_table_privilege('public','retained_data','select') AS retained"))[0].retained).toBe(true);await data.close();
 const old=Bun.spawn(['psql','-h','127.0.0.1','-p','55439','-U','copy_notes','-d','copy_notes','-w','-c','SELECT 1'],{env:{...process.env,PGPASSWORD:'fixture-old'},stdout:'ignore',stderr:'ignore'});
 expect(await old.exited).not.toBe(0);
 await db.unsafe('ALTER ROLE copy_notes CREATEDB');
 await expect(copy.prepareCopyAppDatabase(app,'c'.repeat(96))).rejects.toThrow('adapter');expect(written).toBe(secret);
});
