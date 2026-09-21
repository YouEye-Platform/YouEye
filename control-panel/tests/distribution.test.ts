import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { distributionBytes, verifyDistribution } from '../src/lib/releases/distribution';
const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({type:'spki',format:'pem'}).toString();
function fixture(overrides: Record<string,unknown> = {}) {
 const payload = Buffer.from(JSON.stringify({schema:'youeye.distribution.v1',channel:'stable',sequence:1,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),repositories:{YouEye:{releases:[{tag_name:'appliance-v1',published_at:'2026-01-01',assets:[]}]}},...overrides}));
 return JSON.stringify({payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')});
}
test('signed distribution rejects expired and wrong-channel catalogs',()=>{
 assert.equal(verifyDistribution(fixture(),'stable',pem).catalog.sequence,1);
 assert.throws(()=>verifyDistribution(fixture({expires_at:'2000-01-01'}),'stable',pem));
 assert.throws(()=>verifyDistribution(fixture(),'beta',pem));
 const e=JSON.parse(fixture());e.payload=Buffer.from('{}').toString('base64');
 assert.throws(()=>verifyDistribution(JSON.stringify(e),'stable',pem));
});
test('official discovery makes no GitHub request; outage never falls back',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'distribution-'));process.env.YOUEYE_DISTRIBUTION_STATE=root;
 try {
 const policy={schema:'youeye.distribution-policy.v1',origin:'https://releases.example.test',keys:{stable:pem}};
 let calls=0;
 const transport=(async(url: string)=>{assert.equal(url,'https://releases.example.test/v1/stable.json');calls++;return new Response(fixture());}) as typeof fetch;
 const source='https://api.github.com/repos/YouEye-Platform/YouEye/releases';
 assert.equal(JSON.parse((await distributionBytes(source,policy,transport))!.toString())[0].tag_name,'appliance-v1');
 assert.equal((await distributionBytes(source+'?page=2',policy,transport))!.toString(),'[]');assert.equal(calls,1);
 assert.equal(await distributionBytes('https://api.github.com/repos/third/repo/releases',policy,transport),null);
 await assert.rejects(distributionBytes(source,{...policy,origin:'https://offline.example.test'},(async()=>{throw new Error('offline')}) as typeof fetch),/offline/);
 } finally {delete process.env.YOUEYE_DISTRIBUTION_STATE;await rm(root,{recursive:true,force:true});}
});
