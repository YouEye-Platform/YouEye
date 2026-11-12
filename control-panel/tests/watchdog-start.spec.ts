import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function fixture(options: { busy?: boolean; maintenance?: boolean; stopped?: boolean; running?: boolean; storage?: boolean; disabledAutostart?: boolean; fail?: boolean } = {}) {
  let held = false;
  const events: string[] = [];
  const code = ts.transpileModule(readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(), 'src/lib/health/watchdog-start.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const api: any = {};
  runInNewContext(code, {exports: api, encodeURIComponent, require(id: string) {
    if (id.endsWith('update-admission')) return {async withContainerLifecycle(_name: string, work: () => Promise<unknown>) {
      if (options.busy) throw Error('App update executor lock is busy');
      held = true; events.push('lock');
      try { return await work(); } finally { held = false; events.push('unlock'); }
    }};
    if (id.endsWith('container-maintenance')) return {isContainerMaintenanceActive() {assert.ok(held); return !!options.maintenance;}};
    if (id.endsWith('metadata')) return {async listInstalledApps() {assert.ok(held); return [{appId:'searxng', containers:['app-searxng-redis'], desiredState: options.stopped ? 'stopped' : 'running'}];}};
    if (id.endsWith('storage')) return {async inspectAppStorage() {assert.ok(held); return {available: options.storage !== false};}};
    if (id.endsWith('server')) return {async incusRequest(method: string) {
      assert.ok(held); events.push(method);
      return method === 'GET' ? {metadata: {status: options.running ? 'Running' : 'Stopped', config: {'boot.autostart': options.disabledAutostart ? 'false' : 'true'}}} : {operation: '/1.0/operations/start'};
    }};
    if (id.endsWith('oci-deployer')) return {async waitForIncusOperation() {await Promise.resolve(); assert.ok(held); events.push('terminal'); if (options.fail) throw Error('operation failed');}};
    throw Error(id);
  }});
  return {api, events};
}

test('watchdog holds shared lifecycle admission until terminal start operation', async () => {
  const f = fixture(); assert.equal(await f.api.startWatchdogContainer('app-searxng-redis'), true);
  assert.deepEqual(f.events, ['lock','GET','PUT','terminal','unlock']);
});
test('rename holding app admission prevents the watchdog from starting its stopped dependency', async () => {
  const f = fixture({busy:true}); await assert.rejects(f.api.startWatchdogContainer('app-searxng-redis'), /busy/); assert.deepEqual(f.events, []);
});
test('stale stopped observations cannot override current state, owner intent, maintenance or unavailable storage', async () => {
  for (const options of [{running:true}, {stopped:true}, {maintenance:true}, {storage:false}, {disabledAutostart:true}]) {
    const f = fixture(options); assert.equal(await f.api.startWatchdogContainer('app-searxng-redis'), false); assert.ok(!f.events.includes('PUT')); assert.equal(f.events.at(-1),'unlock');
  }
});
test('failed Incus operation propagates and releases admission without claiming a start', async () => {
  const f=fixture({fail:true}); await assert.rejects(f.api.startWatchdogContainer('app-searxng-redis'), /operation failed/); assert.equal(f.events.at(-1),'unlock');
});

test('actual URL update re-reads app intent under admission and never restarts a now-stopped app', async () => {
  let held=false;
  const events:string[]=[];
  const current={appId:'searxng',containers:['app-searxng-redis','app-searxng-main'],desiredState:'stopped',domain:'first.test',marker:'concurrent-change'};
  const root=process.env.CONTROL_PANEL_ROOT||process.cwd();
  const source=readFileSync(path.join(root,'src/lib/reconfigure/index.ts'),'utf8')+'\nexport { updateInstalledApp };';
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const api:any={};
  runInNewContext(code,{exports:api,console,process:{env:{}},require(id:string){
    if(id==='@/lib/market/update-admission')return {async withAppLifecycle(_id:string,work:()=>Promise<unknown>){held=true;events.push('lock');try{return await work();}finally{held=false;events.push('unlock');}}};
    if(id==='@/lib/market/metadata')return {async readInstallMetadata(){assert.ok(held);events.push('read');return {...current};},async saveInstallMetadata(meta:any){assert.ok(held);assert.equal(meta.marker,'concurrent-change');assert.equal(meta.domain,'next.test');events.push('save');}};
    if(id==='@/lib/incus/server')return {async execShell(){assert.ok(held);return {exitCode:1};},async incusRequest(method:string){assert.ok(held);assert.equal(method,'GET');return {metadata:{config:{}}};}};
    if(id==='@/lib/infrastructure/oci-deployer')return {async restartContainerAndWait(){assert.fail('owner-stopped app restarted');}};
    if(id==='@/lib/market/catalog')return {async fetchManifestFromSource(){return null;}};
    return {};
  }});
  await api.updateInstalledApp({...current,desiredState:'running',marker:'stale'},'first.test','next.test',()=>{});
  assert.deepEqual(events,['lock','read','save','unlock']);
});
