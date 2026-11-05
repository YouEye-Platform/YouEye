import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { bindVerifiedSetupChannel } from '../src/lib/youeye-names/verified-setup-channel';
import { parseVerifiedSetupResult, validVerifiedSetupChallenge, verifiedSetupProtocol, type VerifiedSetupChallenge } from '../src/lib/youeye-names/verified-setup-contract';
import { privateNamesAddress, verifiedSetupParentOrigin } from '../src/lib/youeye-names/setup-request';

function fixture() {
  const original=Object.getOwnPropertyDescriptor(globalThis,'window');
  const listeners=new Set<(event:MessageEvent)=>void>();
  const frameMessages:any[]=[];const popupMessages:any[]=[];
  const frame={postMessage:(...value:any[])=>frameMessages.push(value)} as unknown as Window;
  let closed=false;
  const popup={postMessage:(...value:any[])=>popupMessages.push(value),close(){closed=true;},focus(){},get closed(){return closed;}} as unknown as Window;
  let opened='';
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin:'https://192.168.1.50'},
    addEventListener:(_:string,fn:(event:MessageEvent)=>void)=>listeners.add(fn),removeEventListener:(_:string,fn:(event:MessageEvent)=>void)=>listeners.delete(fn),
    setTimeout,setInterval,open:(url:string)=>{opened=url;return popup;}}});
  const challenge:VerifiedSetupChallenge={purpose:'verified_setup',serviceOrigin:'https://names.test',enrollmentUrl:'https://names.test/enroll/setup?admission=public-parent-grant#context=public-context',embeddedEnrollmentUrl:'https://names.test/enroll/embedded?admission=public-parent-grant',
    context:'bound-context'.repeat(5),cdata:'bound-cdata',publicKey:'A'.repeat(43),installFingerprint:'B'.repeat(43),
    expiresAt:new Date(Date.now()+60000).toISOString(),name:'calm-river',currentIp:'192.168.1.50',parentOrigin:'https://192.168.1.50',sessionId:'random-channel'.repeat(2)};
  const envelope=(type:string)=>({protocol:verifiedSetupProtocol,v:1,type,sessionId:challenge.sessionId});
  const result=()=>({...envelope('result'),setupSession:challenge.context+'.'+'C'.repeat(43),expiresAt:new Date(Date.now()+30000).toISOString(),binding:{installFingerprint:challenge.installFingerprint,name:challenge.name,currentIp:challenge.currentIp}});
  const emit=(data:unknown,source:unknown=frame,origin=challenge.serviceOrigin)=>{for(const fn of [...listeners])fn({data,source,origin} as MessageEvent);};
  return{challenge,envelope,result,emit,frame,popup,frameMessages,popupMessages,listeners,opened:()=>opened,
    restore(){if(original)Object.defineProperty(globalThis,'window',original);else Reflect.deleteProperty(globalThis,'window');}};
}

test('setup iframe pins Window, origin, channel, exact binding and expiry before acknowledgement',()=>{
  const f=fixture();const abort=new AbortController();const credentials:string[]=[];
  const channel=bindVerifiedSetupChannel(f.challenge,{frameWindow:()=>f.frame,signal:abort.signal,accept:value=>credentials.push(value),state:()=>{}});
  try {
    f.emit(f.envelope('ready'),{});f.emit(f.envelope('ready'),f.frame,'https://other-install.ui.bingo');f.emit({...f.envelope('ready'),sessionId:'stale-channel'});
    assert.equal(f.frameMessages.length,0);
    // A correctly shaped result is ignored before a real handshake.
    f.emit(f.result());assert.equal(credentials.length,0);
    f.emit(f.envelope('ready'));
    assert.deepEqual(f.frameMessages[0],[{...f.envelope('init'),context:f.challenge.context,cdata:f.challenge.cdata,publicKey:f.challenge.publicKey},f.challenge.serviceOrigin]);
    for(const changed of [
      {...f.result(),binding:{...f.result().binding,name:'other-river'}},
      {...f.result(),binding:{...f.result().binding,currentIp:'192.168.1.51'}},
      {...f.result(),binding:{...f.result().binding,installFingerprint:'Z'.repeat(43)}},
      {...f.result(),expiresAt:'invalid'}, {...f.result(),expiresAt:new Date(0).toISOString()},
      {...f.result(),expiresAt:new Date(Date.now()+600000).toISOString()},
      {...f.result(),setupSession:'different-context.'+'C'.repeat(43)}, {...f.result(),extra:'not-admitted'},
    ])f.emit(changed);
    assert.equal(credentials.length,0);
    f.emit(f.result());assert.equal(credentials.length,1);
    assert.deepEqual(f.frameMessages[1],[f.envelope('ack'),f.challenge.serviceOrigin]);
    assert.equal(f.listeners.size,0);
    f.emit(f.result());assert.equal(credentials.length,1);
  }finally{channel.dispose();f.restore();}
});

test('fallback shares the admitted challenge and cancellation prevents late results',()=>{
  const f=fixture();const abort=new AbortController();let accepted=0;
  const channel=bindVerifiedSetupChannel(f.challenge,{frameWindow:()=>f.frame,signal:abort.signal,accept:()=>accepted++,state:()=>{}});
  try {
    assert.equal(channel.openStandalone(),true);assert.equal(f.opened(),f.challenge.enrollmentUrl);
    f.emit(f.envelope('ready'),f.popup);assert.equal(f.popupMessages[0][0].context,f.challenge.context);
    abort.abort();assert.equal(f.listeners.size,0);assert.equal(f.popup.closed,true);
    f.emit(f.result(),f.popup);assert.equal(accepted,0);
    assert.equal(channel.acceptPasted(f.result().setupSession),false);
  }finally{channel.dispose();f.restore();}
});

test('manual fallback accepts only the current bound credential and never an expired or substituted one',()=>{
  const f=fixture();const abort=new AbortController();let accepted=0;
  const channel=bindVerifiedSetupChannel(f.challenge,{frameWindow:()=>f.frame,signal:abort.signal,accept:()=>accepted++,state:()=>{}});
  try {
    assert.equal(channel.acceptPasted('other.'+'C'.repeat(43)),false);
    assert.equal(channel.acceptPasted(f.challenge.context+'.bad'),false);
    assert.equal(channel.acceptPasted(f.result().setupSession),true);assert.equal(accepted,1);
    assert.equal(channel.acceptPasted(f.result().setupSession),false);
    assert.equal(validVerifiedSetupChallenge({...f.challenge,embeddedEnrollmentUrl:'https://evil.test/enroll/embedded?admission=x'},f.challenge.parentOrigin,f.challenge.sessionId),false);
    assert.equal(parseVerifiedSetupResult({...f.result(),expiresAt:'not-a-date'},f.challenge),null);
  }finally{channel.dispose();f.restore();}
});

test('the server derives an exact admitted browser origin from actual Host, never caller body or forwarded host',()=>{
  const request=(origin:string,host='192.168.1.50')=>new NextRequest('http://control-panel:3000/api/tls/youeye-names/enrollment',{headers:{origin,host,'x-forwarded-host':'attacker.ui.bingo'}});
  assert.equal(verifiedSetupParentOrigin(request('https://192.168.1.50')),'https://192.168.1.50');
  for(const bad of ['null','https://other-install.ui.bingo','https://192.168.1.50/','https://user@192.168.1.50','https://192.168.1.50?parent=evil'])assert.throws(()=>verifiedSetupParentOrigin(request(bad)));
  assert.throws(()=>verifiedSetupParentOrigin(request('http://public.example','public.example')));
  assert.equal(verifiedSetupParentOrigin(request('http://192.168.1.50')),'http://192.168.1.50');
  for(const ip of ['10.0.0.2','172.16.0.2','192.168.1.50','100.64.0.1','fd00::1'])assert.equal(privateNamesAddress(ip),true);
  for(const ip of ['127.0.0.1','169.254.1.1','8.8.8.8','fe80::1','::1'])assert.equal(privateNamesAddress(ip),false);
});
