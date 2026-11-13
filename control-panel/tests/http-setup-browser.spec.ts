import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { randomBrowserUUID } from '../src/lib/browser-random';
import * as verifiedChannel from '../src/lib/youeye-names/verified-setup-channel';
import * as restoreStatus from '../src/components/setup/restore-status';

type Element = { type: string; props: Record<string, any> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function flush() { for (let i=0;i<8;i++) await new Promise<void>(resolve=>setImmediate(resolve)); }

/** Compile the actual client components with a small hook/DOM adapter. These
 * exercise event handlers and fetches, without claiming real browser/provider
 * acceptance or replacing the native secure-random implementation. */
function browser() {
  const previous = new Map(['crypto','window','fetch','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const listeners = new Set<(event:MessageEvent)=>void>();
  const timers = new Map<number,()=>void>(); let nextTimer=0, randomCalls=0;
  const stored = new Map<string,string>();
  const sent:any[]=[];
  const frame = {postMessage:(...value:any[])=>sent.push(value)};
  const window = {location:{origin:'http://192.168.1.50',replace(){}},
    addEventListener:(_:string,fn:(event:MessageEvent)=>void)=>listeners.add(fn),
    removeEventListener:(_:string,fn:(event:MessageEvent)=>void)=>listeners.delete(fn),
    setTimeout:(fn:()=>void)=>{timers.set(++nextTimer,fn);return nextTimer;},
    clearTimeout:(id:number)=>timers.delete(id),setInterval:()=>++nextTimer,open:()=>null};
  const crypto = {getRandomValues<T extends ArrayBufferView>(bytes:T) {randomCalls++;return webcrypto.getRandomValues(bytes);}};
  const sessionStorage = {getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)};
  for (const [key,value] of Object.entries({crypto,window,sessionStorage})) Object.defineProperty(globalThis,key,{configurable:true,value});
  return {window,crypto,sessionStorage,frame,sent,stored,listeners,randomCalls:()=>randomCalls,
    emit(data:unknown,source:unknown=frame,origin='https://names.test') {for(const fn of [...listeners])fn({data,source,origin} as MessageEvent);},
    tick() {const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();},
    component(filename:string, additions:Record<string,unknown>={}) {
      const slots:any[]=[];let cursor=0;const effects:Array<()=>void>=[];
      const useState=(initial:any)=>{const slot=cursor++;if(!(slot in slots))slots[slot]=typeof initial==='function'?initial():initial;return [slots[slot],(next:any)=>{slots[slot]=typeof next==='function'?next(slots[slot]):next;}];};
      const useRef=(initial:any)=>{const slot=cursor++;return slots[slot]??=( {current:initial} );};
      const useEffect=(effect:()=>void|(()=>void),dependencies?:any[])=>{
        const slot=cursor++, previous=slots[slot];
        if(!previous || !dependencies || dependencies.some((value,index)=>!Object.is(value,previous.dependencies[index]))) {
          slots[slot]={dependencies,cleanup:previous?.cleanup};
          effects.push(()=>{slots[slot].cleanup?.();slots[slot].cleanup=effect();});
        }
      };
      const jsx=(type:string,props:Record<string,any>)=>{if(type==='iframe'&&props.ref)props.ref.current={contentWindow:frame,focus(){}};return {type,props};};
      const dependencies:Record<string,unknown>={
        react:{useState,useRef,useEffect,useCallback:(fn:any)=>fn},'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},
        'next-intl':{useLocale:()=> 'en',useTranslations:()=> (key:string)=>key},
        'lucide-react':new Proxy({},{get:(_,key)=>String(key)}),
        '@/components/ui/button':{Button:'button'},'@/components/ui/input':{Input:'input'},'@/components/ui/label':{Label:'label'},
        '@/lib/browser-random':{randomBrowserUUID},...additions,
      };
      const output=ts.transpileModule(readFileSync(path.join(import.meta.dirname,'..',filename),'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
      const exports:Record<string,any>={};
      vm.runInNewContext(output,{exports,require:(id:string)=>{if(id in dependencies)return dependencies[id];throw Error('Unexpected client dependency '+id);},
        window,document:{body:{},activeElement:{}},sessionStorage,crypto,fetch:(...args:Parameters<typeof fetch>)=>globalThis.fetch(...args),
        AbortController,AbortSignal,TextDecoder,URL,Date,JSON,setTimeout:window.setTimeout,clearTimeout:window.clearTimeout,clearInterval(){}});
      return {render(props:Record<string,any>={}) {cursor=0;const element=(exports.default??exports.OnboardingClient)(props) as Element;for(const effect of effects.splice(0))effect();return element;},
        dispose(){for(const slot of slots)slot?.cleanup?.();}};
    },
    restore() {for(const [key,descriptor] of previous) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
  };
}
function find(tree:any,predicate:(value:Element)=>boolean):Element {
  if(tree&&typeof tree==='object'&&!Array.isArray(tree)&&tree.props&&predicate(tree))return tree;
  for(const child of Array.isArray(tree)?tree:tree?.props?.children?[tree.props.children]:[]) {try{return find(child,predicate);}catch{}}
  throw Error('Client control not found');
}
function text(tree:any):string {return Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):String(tree??'');}

test('HTTP fresh setup creates a secure channel and accepts one admitted verified-registration result without UUID/subtle APIs',async()=>{
  const b=browser();let challenge:any;const verified:any[]=[];const requests:any[]=[];
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/csrf'))return Response.json({csrfToken:'fixture-csrf'});
    const input=JSON.parse(String(init?.body));requests.push(input);assert.match(input.sessionId,uuid);
    challenge={purpose:'verified_setup',serviceOrigin:'https://names.test',enrollmentUrl:'https://names.test/enroll/setup?admission=fixture',embeddedEnrollmentUrl:'https://names.test/enroll/embedded?admission=fixture',
      context:'signed-context'.repeat(4),cdata:'bound-cdata',publicKey:'A'.repeat(43),installFingerprint:'B'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString(),name:'calm-river',currentIp:'192.168.1.50',parentOrigin:b.window.location.origin,sessionId:input.sessionId};
    return Response.json({challenge});
  };
  const client=b.component('src/components/setup/SetupNamesVerification.tsx',{'@/lib/youeye-names/verified-setup-channel':verifiedChannel,'@/lib/youeye-names/popup':{runNamesEnrollment(){throw Error('Unexpected enrollment popup');}}});
  const props={name:'calm-river',fqdn:'calm-river.ui.bingo',useVerifiedSetup:true,onVerified:(...value:any[])=>verified.push(value),onBack(){}};
  try {
    find(client.render(props),node=>node.type==='button'&&Boolean(node.props.onClick)&&node.props.variant!=='ghost').props.onClick();await flush();
    client.render(props);
    assert.deepEqual(requests,[{action:'challenge',purpose:'verified_setup',name:'calm-river',sessionId:challenge.sessionId}]);
    const envelope={protocol:'youeye-names.verified-setup',v:1,sessionId:challenge.sessionId};
    b.emit({...envelope,type:'ready'});assert.equal(b.sent[0][0].context,challenge.context);
    const result={...envelope,type:'result',setupSession:challenge.context+'.'+'C'.repeat(43),expiresAt:new Date(Date.now()+30000).toISOString(),binding:{installFingerprint:challenge.installFingerprint,name:challenge.name,currentIp:challenge.currentIp}};
    b.emit({...result,setupSession:'substituted.'+'C'.repeat(43)});assert.equal(verified.length,0);
    b.emit(result);b.emit(result);
    assert.deepEqual(verified,[[result.setupSession,'verified_setup']]);
    assert.equal(b.sent.filter(entry=>entry[0].type==='ack').length,1);assert.equal(b.randomCalls(),1);assert.equal(b.listeners.size,0);
  } finally {client.dispose();b.restore();}
});

for(const resume of [false,true])test(`HTTP imported restore ${resume?'retains its recovery UUID':'creates an accepted operation UUID'} without secure-context-only APIs`,async()=>{
  const b=browser();const retained='a1234567-1234-4234-8234-123456789abc';const backupId='backup-20261029T120000Z-1234abcd';const submitted:any[]=[];
  if(resume)b.stored.set('youeye-setup-restore-operation',retained);
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/csrf'))return Response.json({csrfToken:'fixture-csrf'});
    if(init?.method==='POST') {submitted.push(JSON.parse(String(init.body)));return new Response('data: [DONE]\n\n');}
    if(String(url).includes('?operationId=')) {
      const id=new URL(String(url),'http://192.168.1.50').searchParams.get('operationId');
      return Response.json(submitted.length?{operationId:id,status:'completed',message:'Complete'}:{operationId:id,status:'failed',active:false,recovery:'resume',message:'Interrupted',mediaId:'drive',backupId,appIds:['notes']});
    }
    return Response.json({recoveryPoints:[{mediaId:'drive',backupId,apps:['notes'],createdAt:new Date().toISOString()}]});
  };
  const client=b.component('src/components/setup/SetupRestore.tsx',{'./restore-status':restoreStatus});
  try {
    client.render({onComplete(){},onBack(){}});await flush();
    let tree=client.render({onComplete(){},onBack(){}});
    find(tree,node=>node.props.id==='passphrase').props.onChange({target:{value:'fixture-recovery-passphrase'}});
    tree=client.render({onComplete(){},onBack(){}});
    const start=find(tree,node=>node.type==='button'&&node.props.variant!=='ghost');assert.equal(start.props.disabled,false);await start.props.onClick();
    assert.equal(submitted.length,1);assert.match(submitted[0].operationId,uuid);
    assert.deepEqual({...submitted[0],operationId:'checked'},{operationId:'checked',action:resume?'resume':'start',mediaId:'drive',backupId,appIds:['notes'],passphrase:'fixture-recovery-passphrase'});
    assert.equal(b.randomCalls(),resume?0:1);if(resume)assert.equal(submitted[0].operationId,retained);
    assert.equal(b.stored.has('youeye-setup-restore-operation'),false);
  } finally {client.dispose();b.restore();}
});

test('HTTP personal onboarding retains the same secure request UUID when retrying a lost response',async()=>{
  const b=browser();const requests:any[]=[];
  const snapshot={completed:false,has_pin:false,timeline:{configured:false,enabled:false,revision:'initial'}};
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/branding'))return Response.json({site_name:'YouEye'});
    if(String(url).endsWith('/complete')) {requests.push(JSON.parse(String(init?.body)));if(requests.length===1)throw Error('fixture-lost-response');return Response.json({completed:true,enabled:false});}
    return Response.json(snapshot);
  };
  const client=b.component('src/components/onboarding/onboarding-client.tsx',{'@youeye/branding/brand':{Brand:'brand'},'../../../../shared/timeline-secret':{validTimelineSecret:()=>true},'@/components/settings-shell/profile-icon-picker':{ProfileIconPicker:'icons'}});
  try {
    client.render({username:'fixture'});await flush();
    const click=async(label:string)=>{const tree=client.render({username:'fixture'});find(tree,node=>node.type==='button'&&text(node).includes(label)).props.onClick();await flush();client.render({username:'fixture'});b.tick();};
    await click('m31fbef162594');await click('m31fbef162594');await click('m9b83b7e4c548');
    await click('mbc01ae77f37c');await click('mbc01ae77f37c');
    assert.equal(requests.length,2);assert.match(requests[0].request_id,uuid);assert.deepEqual(requests[0],requests[1]);assert.equal(b.randomCalls(),1);
  } finally {client.dispose();b.restore();}
});

test('missing browser secure entropy fails closed without an alternate random source',()=>{
  const b=browser();
  try {Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});assert.throws(()=>randomBrowserUUID());}
  finally {b.restore();}
});
