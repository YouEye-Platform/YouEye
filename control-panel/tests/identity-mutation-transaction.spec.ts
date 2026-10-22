import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
function compile(file: string) {
  return ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText;
}
function fixture(busy = false, commitFails = false) {
  const events: string[] = [];
  let held = false;
  const user = {id:'principal',username:'ordinary',name:'User',first_name:'User',last_name:'',email:'',groups:['youeye-users'],is_admin:false,is_active:true};
  const gate = {async withAppLifecycles(_apps: string[], work: () => Promise<unknown>) {
    events.push('admission');
    if (busy || held) throw new Error('App update executor lock is busy');
    held=true;try {return await work();} finally {held=false;events.push('release');}
  }};
  const transport = {async execShell(_container: string, command: string) {
    let rows: unknown[] = [];
    if (command.includes('CREATE TABLE')) return {exitCode:0,stdout:'[]',stderr:''};
    if (command.includes('SELECT app_id FROM admission_policies')) rows=[{app_id:'notes'}];
    else if (command.includes('UPDATE identity_users')) {
      assert.ok(held);events.push('commit');
      if(commitFails) return {exitCode:1,stdout:'',stderr:'fixture commit failure'};
      rows=[{...user}];
    } else if(command.includes('DELETE FROM identity_users')) {assert.ok(held);events.push('delete');}
    else if(command.includes('FROM identity_users')) rows=[{...user}];
    return {exitCode:0,stdout:JSON.stringify(rows),stderr:''};
  }};
  const store: any = {};
  runInNewContext(compile('src/lib/identity/store.ts'), {exports:store,require:(id:string) => {
    if(id==='crypto') return require(id);
    if(id==='@/lib/postgres/platform') return {async platformCommand(command:string) {
      const result = await transport.execShell('postgres',command);
      if(result.exitCode) throw new Error(result.stderr);
      return result.stdout;
    }};
    if(id==='@/lib/apps/manifest') return {POSTGRES_MANIFEST:{containerName:'postgres'}};
    if(id==='./password-policy') return {requireIdentityPassword(){}};
    if(id==='@/lib/admission/schema') return {ADMISSION_SCHEMA_SQL:''};
    if(id==='@/lib/updates/core-schema') return {runCoreSchemaOnce:async (_role:string, initialize:()=>Promise<void>) => initialize()};
    if(id==='../market/update-admission') return gate;
    throw Error('Unexpected store dependency '+id);
  }});
  const api: any = {};
  runInNewContext(compile('src/lib/identity/provider.ts'), {exports:api,require:(id:string) => {
    if(id==='crypto') return require(id);
    if(id==='./store') return store;
    if(id==='@/lib/pointer/managed-apps') return {async setPointerManagedActorState(_id:string,state:string) {assert.ok(held);events.push('pointer:'+state);}};
    if(['./config','@/lib/caddy/client','@/lib/settings'].includes(id)) return {};
    throw Error('Unexpected provider dependency '+id);
  }});
  return {api,store,events};
}
test('real provider and store update membership without recursively acquiring admission', async () => {
  const f=fixture();await f.api.updateUser('principal',{groups:['household-a']});
  assert.deepEqual(f.events,['admission','commit','release']);
});
test('direct store callers retain admission and busy gates prevent the callback and write', async () => {
  const f=fixture();await f.store.updateIdentityUser('principal',{groups:['household-a']});
  assert.deepEqual(f.events,['admission','commit','release']);
  const blocked=fixture(true);await assert.rejects(blocked.api.updateUser('principal',{is_active:false}),/lock is busy/);
  assert.deepEqual(blocked.events,['admission']);
});
test('real transaction keeps Pointer activation after commit and suppresses it on commit failure', async () => {
  const f=fixture();await f.api.updateUser('principal',{is_active:true});
  assert.deepEqual(f.events,['admission','commit','pointer:active','release']);
  const failed=fixture(false,true);await assert.rejects(failed.api.updateUser('principal',{is_active:true}),/fixture commit failure/);
  assert.deepEqual(failed.events,['admission','commit','release']);
});
test('real deletion holds admission through Pointer suspension and authoritative deletion', async () => {
  const f=fixture();await f.api.deleteUser('principal');
  assert.deepEqual(f.events,['admission','pointer:disabled','delete','release']);
});
