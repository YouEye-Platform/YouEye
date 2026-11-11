import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExactLxdRelease } from '../src/lib/apps/lxd-release';

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
