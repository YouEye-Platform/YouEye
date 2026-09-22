import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveExactLxdRelease } from '../src/lib/apps/lxd-release';
import { distributionBytes } from '../src/lib/releases/distribution';

test('exact AI artifact resolves from signed metadata with GitHub API blocked, including lowercase defaults',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'lxd-distribution-'));process.env.YOUEYE_DISTRIBUTION_STATE=root;
 try {
  const keys=generateKeyPairSync('ed25519'); const pem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  const download='https://github.com/YouEye-Platform/Pointer/releases/download/v0.5.2/standalone.tar';
  const payload=Buffer.from(JSON.stringify({schema:'youeye.distribution.v1',channel:'stable',sequence:1,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),repositories:{Pointer:{releases:[{tag_name:'v0.5.2',published_at:'2026-09-22',assets:[{name:'standalone.tar',browser_download_url:download}]}]}}}));
  const envelope=JSON.stringify({payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')});
  const network=(async(input:string)=>{assert.equal(input,'https://releases.example.test/v1/stable.json');return new Response(envelope);}) as typeof fetch;
  const transport=(async(input:string)=>{const bytes=await distributionBytes(String(input),{schema:'youeye.distribution-policy.v1',origin:'https://releases.example.test',keys:{stable:pem}},network);assert.ok(bytes,'API network fallback forbidden');return new Response(bytes);}) as typeof fetch;
  const source={provider:'github',base_url:'https://github.com',api_path:'',organization:'youeye-platform'};
  assert.equal(await resolveExactLxdRelease(source,'Pointer','v0.5.2',transport),download);
  assert.equal(await resolveExactLxdRelease(source,'Pointer','v0.5.1',transport),null);
 } finally {delete process.env.YOUEYE_DISTRIBUTION_STATE;await rm(root,{recursive:true,force:true});}
});

test('exact lookup preserves custom source and searches later pages without accepting another tag',async()=>{
 const source={provider:'gitea',base_url:'https://forge.example.test',api_path:'/api/v1',organization:'team'};
 const download='https://forge.example.test/team/custom/releases/download/dev-v2/standalone.tar';let calls=0;
 const transport=(async(input:string)=>{
  const url=new URL(String(input));assert.equal(url.origin,source.base_url);assert.equal(url.pathname,'/api/v1/repos/team/custom/releases');calls++;
  return new Response(JSON.stringify(url.searchParams.get('page')==='1'?Array.from({length:50},()=>({tag_name:'v1'})):[{tag_name:'dev-v2',assets:[{name:'standalone.tar',browser_download_url:download}]}]));
 }) as typeof fetch;
 assert.equal(await resolveExactLxdRelease(source,'custom','dev-v2',transport),download);assert.equal(calls,2);
 await assert.rejects(resolveExactLxdRelease(source,'custom','v1',(async()=>new Response('{}',{status:403})) as typeof fetch),/HTTP 403/);
 await assert.rejects(resolveExactLxdRelease(source,'custom','v1',(async()=>new Response('{}')) as typeof fetch),/Invalid release response/);
});
