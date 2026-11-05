'use client';

import { exactKeys, parseVerifiedSetupResult, validVerifiedSetupChallenge, verifiedSetupProtocol, type VerifiedSetupChallenge } from './verified-setup-contract';

export async function requestVerifiedSetupChallenge(name: string, sessionId: string, signal: AbortSignal): Promise<VerifiedSetupChallenge> {
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
  const csrf=await fetch('/api/auth/csrf',{cache:'no-store',redirect:'error',signal:deadline}).then(response=>response.json()) as {csrfToken?:string};
  if (!csrf.csrfToken) throw new Error('setup_auth_expired');
  const response=await fetch('/api/tls/youeye-names/enrollment',{
    method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf.csrfToken},
    body:JSON.stringify({action:'challenge',purpose:'verified_setup',name,sessionId}),
    cache:'no-store',redirect:'error',signal:deadline,
  });
  const body=await response.json().catch(()=>({})) as {challenge?:VerifiedSetupChallenge};
  if (!response.ok || !body.challenge || body.challenge.name!==name || !validVerifiedSetupChallenge(body.challenge,window.location.origin,sessionId)) throw new Error('setup_challenge_unavailable');
  return body.challenge;
}

/** One disposable browser attempt. A fallback shares its original challenge;
 * it never turns a second human response into a different domain authority. */
export function bindVerifiedSetupChannel(challenge: VerifiedSetupChallenge, input: {
  frameWindow:()=>Window|null; signal:AbortSignal; accept:(credential:string)=>void;
  state:(state:'waiting'|'challenge'|'blocked'|'expired')=>void;
}) {
  if (!validVerifiedSetupChallenge(challenge,window.location.origin,challenge.sessionId)) throw new Error('setup_challenge_invalid');
  let popup:Window|null=null;
  let settled=false;
  const initialized=new Set<MessageEventSource>();
  const envelope=(type:string)=>({protocol:verifiedSetupProtocol,v:1,type,sessionId:challenge.sessionId});
  const cleanup=()=>{
    window.removeEventListener('message',onMessage); clearTimeout(expiry); clearTimeout(readyDeadline); clearInterval(closedCheck);
    input.signal.removeEventListener('abort',cancel);
    if (popup && !popup.closed) popup.close(); popup=null; initialized.clear();
  };
  const cancel=()=>{if(settled)return; settled=true;cleanup();};
  const accept=(credential:string,peer?:Window)=>{
    if (settled || input.signal.aborted || Date.parse(challenge.expiresAt)<=Date.now()) return false;
    // Keep the credential in the caller's in-memory attempt before signalling
    // acknowledgement. Never acknowledge an unmounted/cancelled attempt.
    settled=true;
    try {
      input.accept(credential);
      peer?.postMessage(envelope('ack'),challenge.serviceOrigin);
    } finally { cleanup(); }
    return true;
  };
  const onMessage=(event:MessageEvent)=>{
    if (settled || input.signal.aborted || event.origin!==challenge.serviceOrigin || !event.source || (event.source!==input.frameWindow() && event.source!==popup)) return;
    const value=event.data;
    if (!value || typeof value!=='object' || Array.isArray(value) || value.protocol!==verifiedSetupProtocol || value.v!==1 || value.sessionId!==challenge.sessionId) return;
    if (value.type==='ready' && exactKeys(value,['protocol','v','type','sessionId'])) {
      if(!initialized.has(event.source))input.state('challenge');
      initialized.add(event.source); clearTimeout(readyDeadline);
      (event.source as Window).postMessage({...envelope('init'),context:challenge.context,cdata:challenge.cdata,publicKey:challenge.publicKey},challenge.serviceOrigin);
      return;
    }
    if (!initialized.has(event.source)) return;
    const result=parseVerifiedSetupResult(value,challenge);
    if(result) accept(result.setupSession,event.source as Window);
  };
  window.addEventListener('message',onMessage);
  const expiry=window.setTimeout(()=>{if(settled)return;input.state('expired');cancel();},Math.max(1,Date.parse(challenge.expiresAt)-Date.now()));
  const readyDeadline=window.setTimeout(()=>{if(!settled && initialized.size===0)input.state('blocked');},12000);
  const closedCheck=window.setInterval(()=>{
    if(!settled && popup?.closed){initialized.delete(popup);popup=null;input.state('blocked');}
  },500);
  input.signal.addEventListener('abort',cancel,{once:true});
  if(input.signal.aborted) cancel();
  return {
    dispose:cancel,
    openStandalone() {
      if(settled || input.signal.aborted)return false;
      if(popup && !popup.closed) {popup.focus();return true;}
      popup=window.open(challenge.enrollmentUrl,`youeye-setup-${challenge.sessionId}`,'popup,width=520,height=720,resizable=yes,scrollbars=yes');
      return Boolean(popup);
    },
    acceptPasted(value:string) {
      const credential=value.trim();
      if(credential.length>8192 || !credential.startsWith(challenge.context+'.') || !/^[A-Za-z0-9_-]{43}$/.test(credential.slice(challenge.context.length+1)))return false;
      return accept(credential);
    },
  };
}
