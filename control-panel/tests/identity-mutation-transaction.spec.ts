import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import test, {type TestContext} from 'node:test';
import ts from 'typescript';
import {ADMISSION_SCHEMA_SQL} from '../src/lib/admission/schema';
import {ADMISSION_COPY_SCHEMA_SQL} from '../src/lib/copy/admission-schema';
import {AppUpdateExecutorLock} from '../src/lib/market/update-executor-lock';
import * as journal from '../src/lib/market/update-journal';

const require = createRequire(import.meta.url);
const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
function compile(file: string) {
  return ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
}
function fixture(t: TestContext, options: {
  busy?: boolean;
  commitFails?: boolean;
  owner?: boolean;
  beforeCommit?: () => Promise<void>;
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'identity-mutation-'));
  new journal.AppUpdateJournalStore(directory);
  const busyLock = options.busy
    ? AppUpdateExecutorLock.acquire(path.join(directory, 'executors', 'app-notes.lock'))
    : undefined;
  t.after(() => {
    busyLock?.release();
    rmSync(directory, {recursive: true, force: true});
  });
  // Only redirect the journal directory. Admission, reservations, and OS locks
  // execute the production implementation, including across asynchronous work.
  const admission: any = {};
  runInNewContext(compile('src/lib/market/update-admission.ts'), {
    exports: admission,
    process: {env: {YOUEYE_APP_UPDATE_JOURNAL_DIR: directory}, geteuid: process.geteuid},
    require(id: string) {
      if (id.startsWith('node:')) return require(id);
      if (id === './update-executor-lock') return {AppUpdateExecutorLock};
      if (id === './update-journal') return journal;
      throw Error('Unexpected admission dependency '+id);
    },
  });
  const events: string[] = [];
  let held = false;
  const user = {id:'principal',username:'ordinary',name:'User',first_name:'User',last_name:'',email:'',groups:['youeye-users'],is_admin:false,is_active:true};
  const gate = {async withAppLifecycles(apps: string[], work: () => Promise<unknown>) {
    assert.deepEqual(Array.from(apps), ['identity', 'notes']);
    events.push('admission');
    return admission.withAppLifecycles(apps, async () => {
      assert.equal(held, false, 'provider/store must not recursively acquire admission');
      held=true;try {return await work();} finally {held=false;events.push('release');}
    });
  }};
  const transport = {async execShell(_container: string, command: string) {
    let rows: unknown[] = [];
    if (command.includes('CREATE TABLE')) {
      assert.ok(command.includes(ADMISSION_SCHEMA_SQL));
      assert.ok(command.includes(ADMISSION_COPY_SCHEMA_SQL));
      return {exitCode:0,stdout:'[]',stderr:''};
    }
    if (command.includes('SELECT app_id FROM admission_policies')) rows=[{app_id:'notes'}];
    else if (command.includes('SELECT owner_user_id FROM identity_appliance_claim')) {
      rows = options.owner ? [{owner_user_id: user.id}] : [];
    }
    else if (command.includes('UPDATE identity_users')) {
      assert.ok(held);events.push('commit');
      await options.beforeCommit?.();
      if(options.commitFails) return {exitCode:1,stdout:'',stderr:'fixture commit failure'};
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
    if(id==='./username-policy') return require('../src/lib/identity/username-policy.ts');
    if(id==='@/lib/admission/schema') return {ADMISSION_SCHEMA_SQL};
    if(id==='@/lib/copy/admission-schema') return {ADMISSION_COPY_SCHEMA_SQL};
    if(id==='@/lib/updates/core-schema') return {runCoreSchemaOnce:async (role:string, initialize:()=>Promise<void>) => {
      assert.equal(role, 'cp');
      return initialize();
    }};
    if(id==='../market/update-admission') return gate;
    if(id==='./forward-auth-cache') return {clearForwardAuthCaches(){}};
    throw Error('Unexpected store dependency '+id);
  }});
  const api: any = {};
  runInNewContext(compile('src/lib/identity/provider.ts'), {exports:api,require:(id:string) => {
    if(id==='crypto') return require(id);
    if(id==='./store') return store;
    if(id==='@/lib/pointer/managed-apps') return {async setPointerManagedActorState(_id:string,state:string) {assert.ok(held);events.push('pointer:'+state);}};
    if(['./config','@/lib/caddy/client','@/lib/settings'].includes(id)) return {};
    // Console access syncs after the identity commit, never inside identity admission.
    if(id==='@/lib/console-access') return {async afterIdentityChange() {assert.equal(held, false);}};
    throw Error('Unexpected provider dependency '+id);
  }});
  return {api,store,events,directory};
}
test('real provider and store update membership without recursively acquiring admission', async t => {
  const f=fixture(t);await f.api.updateUser('principal',{groups:['household-a']});
  assert.deepEqual(f.events,['admission','commit','release']);
});
test('direct store callers retain admission and busy gates prevent the callback and write', async t => {
  const f=fixture(t);await f.store.updateIdentityUser('principal',{groups:['household-a']});
  assert.deepEqual(f.events,['admission','commit','release']);
  const blocked=fixture(t,{busy:true});await assert.rejects(blocked.api.updateUser('principal',{is_active:false}),/lock is busy/);
  assert.deepEqual(blocked.events,['admission']);
  let callbackCalls = 0;
  await assert.rejects(blocked.store.updateIdentityUser('principal', async () => {
    callbackCalls++;
    return {isActive:false};
  }, async () => { callbackCalls++; }), /lock is busy/);
  assert.equal(callbackCalls, 0);
  assert.deepEqual(blocked.events, ['admission', 'admission']);
  // Contention on the later Notes gate must release the earlier Identity gate.
  const identityLock = AppUpdateExecutorLock.acquire(path.join(blocked.directory, 'executors', 'app-identity.lock'));
  identityLock.release();
});
test('real transaction keeps Pointer activation after commit and suppresses it on commit failure', async t => {
  const f=fixture(t);await f.api.updateUser('principal',{is_active:true});
  assert.deepEqual(f.events,['admission','commit','pointer:active','release']);
  const failed=fixture(t,{commitFails:true});await assert.rejects(failed.api.updateUser('principal',{is_active:true}),/fixture commit failure/);
  assert.deepEqual(failed.events,['admission','commit','release']);
});
test('real deletion holds admission through Pointer suspension and authoritative deletion', async t => {
  const f=fixture(t);await f.api.deleteUser('principal');
  assert.deepEqual(f.events,['admission','pointer:disabled','delete','release']);
});

test('protected owner disposition denies external and authoritative identity effects', async t => {
  for (const action of ['disable', 'delete']) {
    const f = fixture(t, {owner:true});
    await assert.rejects(action === 'disable'
      ? f.api.updateUser('principal', {is_active:false})
      : f.api.deleteUser('principal'), /Appliance owner and management recovery access must remain active/);
    assert.deepEqual(f.events, ['admission', 'release']);
  }
});

test('a retained System reservation denies identity callbacks and writes', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.directory, 'core-reservation.json'), JSON.stringify({
    schema: 'youeye.core-lifecycle.v1', request_id: 'system:test', manifest_sha256: 'a'.repeat(64),
  }), {mode:0o600});
  let callbackCalls = 0;
  await assert.rejects(f.store.updateIdentityUser('principal', async () => {
    callbackCalls++;
    return {groups:['household-a']};
  }), /A System update owns the platform lifecycle/);
  assert.equal(callbackCalls, 0);
  assert.deepEqual(f.events, ['admission']);
});

test('identity admission serializes a competing mutation while the SQL commit awaits', {timeout:10_000}, async t => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(t, {beforeCommit:async () => { entered(); await pending; }});
  const first = f.api.updateUser('principal', {is_active:true});
  try {
    await started;
    await assert.rejects(f.api.updateUser('principal', {is_active:false}), /lock is busy/);
    assert.deepEqual(f.events, ['admission', 'commit', 'admission']);
  } finally { finish(); }
  await first;
  assert.deepEqual(f.events, ['admission', 'commit', 'admission', 'pointer:active', 'release']);
  const lock = AppUpdateExecutorLock.acquire(path.join(f.directory, 'executors', 'app-notes.lock'));
  lock.release();
});
