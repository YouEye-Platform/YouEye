import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';
import { ProductAssetNotFound, acceptProductSequence, parseProductRelease, verifyProductRelease, identicalProductPayloads, loadProductRelease, loadProductBlob, installedProductProjection, productReceipt, verifyInstalledProductReceipt, type ProductBuild, type ProductRelease } from '../src/lib/releases/product-release';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('release metadata preserves original Beta build authority and installed build identity', async () => {
  const stable = generateKeyPairSync('ed25519'), beta = generateKeyPairSync('ed25519');
  const fingerprint = (key: typeof stable.publicKey) => sha(key.export({type:'spki',format:'der'}));
  const saved = publicPolicy.keys;
  publicPolicy.keys = {...saved, stable:stable.publicKey.export({type:'spki',format:'pem'}).toString(),beta:beta.publicKey.export({type:'spki',format:'pem'}).toString()};
  try {
    for (const product of ['pointer','market','canvas','cinema','notes','search','translate','weather','wiki']) {
      const source = `https://github.com/YouEye-Platform/${product}`, prefix = product === 'market' ? 'catalog-' : '';
      const payload = Buffer.from('immutable source archive fixture');
      const b: ProductBuild = {schema:'youeye.product-build.v1',product,kind:'source',build_version:'0.5.40-beta.1',source,branch:'beta',source_commit:'a'.repeat(40),tag:`${prefix}beta-v0.5.40-beta.1`,input_sha256:'b'.repeat(64),contract_sha256:'c'.repeat(64),signer_sha256:fingerprint(beta.publicKey),primary:'source.tar.gz',assets:[]};
      b.assets = [{name:b.primary,url:`${source}/releases/download/${b.tag}/${b.primary}`,sha256:sha(payload),size_bytes:payload.length}];
      const buildRaw = Buffer.from(JSON.stringify(b));
      const r: ProductRelease = {schema:'youeye.product-release.v1',product,version:'0.5.40',source,branch:'main',tag:`${prefix}v0.5.40`,channel:'stable',sequence:23,minimum_reader:1,signer_sha256:fingerprint(stable.publicKey),build_manifest_base64:buildRaw.toString('base64'),build_signature_base64:sign(null,buildRaw,beta.privateKey).toString('base64')};
      const raw = Buffer.from(JSON.stringify(r)), signature = sign(null,raw,stable.privateKey), expected = {product,source,tag:r.tag};
      const selected = verifyProductRelease(raw,signature,expected);
      assert.equal(installedProductProjection(selected).version,'0.5.40');
      assert.equal(installedProductProjection(selected).build_version,'0.5.40-beta.1');
      assert.equal(verifyInstalledProductReceipt(productReceipt(selected),expected).manifestSHA256,sha(raw));
      const later = {...r,version:'0.5.41',tag:`${prefix}v0.5.41`,sequence:24};
      const laterRaw = Buffer.from(JSON.stringify(later));
      assert.ok(identicalProductPayloads(selected,verifyProductRelease(laterRaw,sign(null,laterRaw,stable.privateKey),{...expected,tag:later.tag})));
      assert.throws(() => verifyProductRelease(raw,signature,{...expected,tag:'v0.0.0'}),/differs/);
      assert.throws(() => verifyProductRelease(raw,sign(null,raw,beta.privateKey),expected),/signature/);
      const wrongBuild = Buffer.from(JSON.stringify({...r,build_signature_base64:sign(null,buildRaw,stable.privateKey).toString('base64')}));
      assert.throws(() => verifyProductRelease(wrongBuild,sign(null,wrongBuild,stable.privateKey),expected),/signature/);
      assert.throws(() => parseProductRelease(Buffer.from(raw.toString().replace('"sequence":23','"sequence":22,"sequence":23'))),/Duplicate/);
      assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...r,extra:true}))),/fields/);
      await assert.rejects(loadProductRelease(['product-release.json'],expected,async()=>raw),/Incomplete/);
      assert.equal(await loadProductRelease(['standalone.tar'],expected,async()=>{throw Error('legacy must not fetch')}),null);
      assert.deepEqual(await loadProductBlob(selected,b.primary,async url=>{assert.equal(url,b.assets[0].url);return payload},1024),payload);
      const calls: string[] = [];
      assert.deepEqual(await loadProductBlob(selected,b.primary,async url=>{
        calls.push(url);
        if (calls.length === 1) throw new ProductAssetNotFound();
        assert.equal(url,`${source}/releases/download/${r.tag}/blob-${sha(payload)}`);
        return payload;
      },1024),payload);
      assert.equal(calls.length,2);
      let forbiddenCalls = 0;
      await assert.rejects(loadProductBlob(selected,b.primary,async()=>{forbiddenCalls++;throw Error('HTTP 403')},1024),/403/);
      assert.equal(forbiddenCalls,1);
      const floors = acceptProductSequence(undefined,selected);
      assert.deepEqual(acceptProductSequence(floors,selected),floors);
      assert.throws(()=>acceptProductSequence(floors,{...selected,manifestSHA256:'f'.repeat(64)}),/substitution/);
      assert.throws(()=>acceptProductSequence(floors,{...selected,release:{...r,sequence:22}}),/rollback/);
      assert.equal(Object.keys(acceptProductSequence(floors,{...selected,release:{...r,branch:'beta',sequence:1}})).length,2);
      await assert.rejects(loadProductBlob(selected,b.primary,async()=>Buffer.alloc(payload.length),1024),/differs/);
    }
  } finally { publicPolicy.keys = saved; }
});
