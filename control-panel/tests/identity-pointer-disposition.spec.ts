import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const source = readFileSync(path.join(root, 'src/lib/identity/provider.ts'), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}}).outputText;

function fixture(options: {busy?: boolean; sqlFails?: boolean; pointerFails?: boolean; active?: boolean} = {}) {
  const events: string[] = [];
  const user = {id:'principal',username:'tester2',name:'User',first_name:'User',last_name:'',email:'',groups:[] as string[],is_admin:false,is_active:options.active ?? true};
  let held = false;
  let pointer = 'disabled';
  const admission = async (work: () => Promise<unknown>) => {
      events.push('admission');
      if (options.busy) throw new Error('App update executor lock is busy');
      held = true;
      try {return await work();} finally {held = false;events.push('release');}
    };
  const store = {
    async getUserById() {assert.ok(held);return {...user};},
    async assertIdentityDisposition() {assert.ok(held);events.push('disposition');},
    async updateIdentityUser(_id: string, resolve: any, after?: (updated: any) => Promise<void>) {
      return admission(async () => {
        const patch = typeof resolve === 'function' ? await resolve({...user}) : resolve;
        assert.ok(held);events.push('identity');
        if (options.sqlFails) throw new Error('Identity write failed');
        if (typeof patch.isActive === 'boolean') user.is_active=patch.isActive;
        if (typeof patch.isAdmin === 'boolean') user.is_admin=patch.isAdmin;
        if (Array.isArray(patch.groups)) user.groups=patch.groups;
        await after?.({...user});
        return {...user};
      });
    },
    async deleteIdentityUser(_id: string, before?: (current: any) => Promise<void>) {
      return admission(async () => {await store.assertIdentityDisposition();await before?.({...user});events.push('delete');});
    },
  };
  const managed = {async setPointerManagedActorState(_id: string, state: string) {
    assert.ok(held);events.push('pointer:'+state);
    if (options.pointerFails) throw new Error('Pointer unavailable');
    if (state === 'active') assert.ok(user.is_active);
    pointer=state;
  }};
  const exports: any = {};
  runInNewContext(compiled, {exports,require:(id:string) => {
    if(id === './store') return store;
    if(id === '@/lib/pointer/managed-apps') return managed;
    if(id === 'crypto') return require(id);
    if(['./config','@/lib/caddy/client','@/lib/settings'].includes(id)) return {};
    throw new Error('Unexpected dependency '+id);
  }});
  return {api:exports,events,user,pointer:()=>pointer};
}

test('busy identity admission has no Pointer or SQL effects, including delete', async () => {
  for (const action of ['disable','delete']) {
    const f=fixture({busy:true});
    await assert.rejects(action==='delete'?f.api.deleteUser('principal'):f.api.updateUser('principal',{is_active:false}), /lock is busy/);
    assert.deepEqual(f.events,['admission']);assert.equal(f.user.is_active,true);
  }
});
test('disable retains the guard and closes Pointer before identity commit', async () => {
  const f=fixture();await f.api.updateUser('principal',{is_active:false});
  assert.deepEqual(f.events,['admission','disposition','pointer:disabled','identity','release']);
  assert.equal(f.user.is_active,false);assert.equal(f.pointer(),'disabled');
});
test('explicit active repairs a disabled Pointer actor even when identity is already active', async () => {
  const f=fixture();await f.api.updateUser('principal',{is_active:true});
  assert.deepEqual(f.events,['admission','identity','pointer:active','release']);assert.equal(f.pointer(),'active');
});
test('identity activation failure cannot enable Pointer', async () => {
  const f=fixture({active:false,sqlFails:true});
  await assert.rejects(f.api.updateUser('principal',{is_active:true}), /Identity write failed/);
  assert.deepEqual(f.events,['admission','identity','release']);assert.equal(f.pointer(),'disabled');
});
test('failed identity disable remains fail-closed and reports failure', async () => {
  const f=fixture({sqlFails:true});
  await assert.rejects(f.api.updateUser('principal',{is_active:false}), /Identity write failed/);
  assert.equal(f.user.is_active,true);assert.equal(f.pointer(),'disabled');assert.equal(f.events.at(-1),'release');
});
test('failed Pointer disable prevents the identity write', async () => {
  const f=fixture({pointerFails:true});
  await assert.rejects(f.api.updateUser('principal',{is_active:false}), /Pointer unavailable/);
  assert.ok(!f.events.includes('identity'));assert.equal(f.user.is_active,true);
});
test('delete holds admission throughout disposition and external cleanup', async () => {
  const f=fixture();await f.api.deleteUser('principal');
  assert.deepEqual(f.events,['admission','disposition','pointer:disabled','delete','release']);
});

test('membership updates acquire one store transaction and preserve the ordinary role', async () => {
  const f=fixture();await f.api.updateUser('principal',{groups:['household-a']});
  assert.deepEqual(f.events,['admission','identity','release']);
  assert.deepEqual(Array.from(f.user.groups),['household-a']);assert.equal(f.user.is_admin,false);
});
test('busy membership updates have no SQL or Pointer effects', async () => {
  const f=fixture({busy:true});await assert.rejects(f.api.updateUser('principal',{groups:['household-a']}),/lock is busy/);
  assert.deepEqual(f.events,['admission']);assert.deepEqual(f.user.groups,[]);
});
