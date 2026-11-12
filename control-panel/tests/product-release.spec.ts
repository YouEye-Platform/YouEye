import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { acceptProductSequence, parseProductRelease, productAssetURL, productTag, verifyProductRelease, identicalProductPayloads, loadProductBlob, installedProductProjection, productReceipt, verifyInstalledProductReceipt } from '../src/lib/releases/product-release';
import { productFixture, tree } from './fixtures/release-fixtures';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('host-independent product releases bind assets by name and digest', async () => {
  for (const product of ['pointer','market','canvas','cinema','notes','search','translate','weather','wiki']) {
    const repository = `https://github.com/YouEye-Platform/${product}`;
    const payload = Buffer.from('immutable archive fixture');
    const f = productFixture(product,'0.6.1-dev.2',repository,{'standalone.tar':payload},{kind:'source'});
    assert.equal(f.tag, product === 'market' ? 'catalog-v0.6.1-dev.2' : 'v0.6.1-dev.2');
    const selected = verifyProductRelease(f.raw,{product,repository,tag:f.tag});
    assert.equal(selected.manifestSHA256,sha(f.raw));
    assert.equal(selected.repository,repository);
    assert.equal(installedProductProjection(selected).version,'0.6.1-dev.2');
    assert.equal(installedProductProjection(selected).source_tree,tree);
    assert.equal(Object.hasOwn(installedProductProjection(selected),'channel'),false);
    assert.deepEqual(Object.keys(productReceipt(selected)).sort(),['manifestBase64','manifestSHA256','repository']);
    assert.equal(verifyInstalledProductReceipt(productReceipt(selected),{product}).manifestSHA256,sha(f.raw));
    assert.throws(() => verifyInstalledProductReceipt({...productReceipt(selected),manifestSHA256:'f'.repeat(64)},{product}),/digest differs/);
    assert.throws(() => verifyProductRelease(f.raw,{product,repository,tag:'v0.0.0'}),/differs/);
    assert.throws(() => verifyProductRelease(f.raw,{product,repository:`${repository}/`,tag:f.tag}),/canonical/);
    // The same bytes are valid in any repository: documents carry no host.
    assert.equal(verifyProductRelease(f.raw,{product,repository:'https://git.example.test/team/X',tag:f.tag}).manifestSHA256,sha(f.raw));
    const relabelled = {...f.release,version:'0.6.1-dev.3',tag:productTag(product,'0.6.1-dev.3'),sequence:1762950001};
    assert.ok(identicalProductPayloads(selected,verifyProductRelease(Buffer.from(JSON.stringify(relabelled)),{product,repository,tag:relabelled.tag})));
    const rebuilt = productFixture(product,'0.6.1-dev.3',repository,{'standalone.tar':Buffer.from('other')},{kind:'source'});
    assert.equal(identicalProductPayloads(selected,verifyProductRelease(rebuilt.raw,{product,repository,tag:rebuilt.tag})),false);
    assert.equal(productAssetURL(selected,selected.build.assets[0]),`${repository}/releases/download/${encodeURIComponent(f.tag)}/standalone.tar`);
    assert.deepEqual(await loadProductBlob(selected,'standalone.tar',async url=>{assert.equal(url,productAssetURL(selected,selected.build.assets[0]));return payload},1024),payload);
    await assert.rejects(loadProductBlob(selected,'standalone.tar',async()=>Buffer.alloc(payload.length),1024),/differs/);
    await assert.rejects(loadProductBlob(selected,'missing.tar',async()=>payload,1024),/no missing.tar/);
  }
});

test('per-host, branch and channel fields are rejected', () => {
  const f = productFixture('notes','0.6.1-dev.1','https://git.example.test/team/Notes',{'standalone.tar':Buffer.from('x')});
  for (const field of ['source','branch','channel','source_commit','previous_manifest_sha256']) {
    assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,[field]:'x'}))),/fields/,field);
    assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,build_manifest_base64:Buffer.from(JSON.stringify({...f.build,[field]:'x'})).toString('base64')}))),/fields/,field);
  }
  for (const field of ['asset_source','asset_tag']) {
    assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,build_manifest_base64:Buffer.from(JSON.stringify({...f.build,[field]:'x'})).toString('base64')}))),/fields/,field);
  }
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,build_manifest_base64:Buffer.from(JSON.stringify({...f.build,assets:[{...f.build.assets[0],url:'https://x.test/a/b/releases/download/v1/standalone.tar'}]})).toString('base64')}))),/fields/);
  // Branch-prefixed tags are gone; the tag never names a channel.
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,tag:'dev-v0.6.1-dev.1'}))),/identity/);
  assert.throws(() => parseProductRelease(Buffer.from(f.raw.toString().replace('"sequence":1762950000','"sequence":1,"sequence":1762950000'))),/Duplicate/);
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,source_tree:'b'.repeat(40)}))),/another build/);
  const native = productFixture('notes','0.6.1-dev.1','https://git.example.test/team/Notes',{'other.tar':Buffer.from('x')},{primary:'other.tar'});
  assert.throws(() => parseProductRelease(native.raw),/standalone.tar/);
});

test('replay floors are per product and order builds, never release names (no downgrade)', () => {
  const repository = 'https://git.example.test/team/Notes';
  const current = verifyProductRelease(productFixture('notes','0.6.1-dev.2',repository,{'standalone.tar':Buffer.from('a')},{sequence:20}).raw,{product:'notes',repository,tag:'v0.6.1-dev.2'});
  const older = verifyProductRelease(productFixture('notes','0.6.1-dev.1',repository,{'standalone.tar':Buffer.from('b')},{sequence:10}).raw,{product:'notes',repository,tag:'v0.6.1-dev.1'});
  const floors = acceptProductSequence(undefined,current);
  assert.deepEqual(floors,{notes:{build:'0.6.1-dev.2',buildSHA256:installedProductProjection(current).build_sha256,manifestSHA256:current.manifestSHA256}});
  assert.deepEqual(acceptProductSequence(floors,current),floors);
  assert.throws(() => acceptProductSequence(floors,older),/older notes build .*catch up/);
  // The same document from another host is the same release.
  const copied = verifyProductRelease(current.raw,{product:'notes',repository:'https://github.com/YouEye-Platform/Notes',tag:'v0.6.1-dev.2'});
  assert.deepEqual(acceptProductSequence(floors,copied),floors);
  // A promoted document: the same build under another name is accepted; the floor keeps the build.
  const promote = (version: string, build: Buffer, buildVersion = '0.6.1-dev.2') => {
    const f = productFixture('notes',version,repository,{'standalone.tar':build},{sequence:30,build:buildVersion});
    return verifyProductRelease(f.raw,{product:'notes',repository,tag:f.tag});
  };
  const alpha = promote('0.6.1-alpha.1',Buffer.from('a'));
  assert.ok(identicalProductPayloads(current,alpha));
  const promoted = acceptProductSequence(floors,alpha);
  assert.deepEqual(promoted.notes,{...floors.notes,manifestSHA256:alpha.manifestSHA256});
  // ...and so is going back to the dev name of that build (e.g. the box changed channel).
  assert.deepEqual(acceptProductSequence(promoted,current),floors);
  // Same build version with other contents is refused.
  assert.throws(() => acceptProductSequence(floors,promote('0.6.1-alpha.1',Buffer.from('other'))),/other contents/);
  // An older build is refused even under a "higher" release name.
  assert.throws(() => acceptProductSequence(floors,promote('0.6.1',Buffer.from('b'),'0.6.1-dev.1')),/older notes build \(0.6.1-dev.1, release 0.6.1\)/);
  // A newer build under a lower-looking name is accepted.
  assert.equal(acceptProductSequence(floors,promote('0.6.1-alpha.2',Buffer.from('c'),'0.6.1-dev.3')).notes.build,'0.6.1-dev.3');
  // A hotfix of an older line published later (higher sequence) is still older.
  const hotfix = verifyProductRelease(productFixture('notes','0.6.1-dev.1',repository,{'standalone.tar':Buffer.from('c')},{sequence:99}).raw,{product:'notes',repository,tag:'v0.6.1-dev.1'});
  assert.throws(() => acceptProductSequence(floors,hotfix),/older notes build/);
  // Floors from before builds were recorded are invalid (boxes are reinstalled).
  assert.throws(() => acceptProductSequence({notes:{version:'0.6.1-dev.2',sequence:20,manifestSHA256:current.manifestSHA256}} as never,current),/Invalid installed product sequence floor/);
});
