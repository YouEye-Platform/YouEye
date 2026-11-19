import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseNeedsNewerReader } from '../src/lib/releases/core-release';
import { createHash } from 'node:crypto';
import { acceptProductSequence, parseProductRelease, productAssetURL, productTag, verifyProductRelease, identicalProductPayloads, loadProductBlob, installedProductProjection, productReceipt, verifyInstalledProductReceipt } from '../src/lib/releases/product-release';
import { productFixture, tree } from './fixtures/release-fixtures';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('host-independent product releases bind assets by name and digest', async () => {
  for (const product of ['pointer','canvas','cinema','notes','search','translate','weather','wiki']) {
    const repository = `https://github.com/YouEye-Platform/${product}`;
    const payload = Buffer.from('immutable archive fixture');
    const f = productFixture(product,'0.6.1-dev.2',repository,{'standalone.tar':payload},{kind:'source'});
    assert.equal(f.tag, 'v0.6.1-dev.2');
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
    const relabelled = {...f.release,version:'0.6.1-dev.3',tag:productTag('0.6.1-dev.3'),sequence:1762950001};
    assert.ok(identicalProductPayloads(selected,verifyProductRelease(Buffer.from(JSON.stringify(relabelled)),{product,repository,tag:relabelled.tag})));
    const rebuilt = productFixture(product,'0.6.1-dev.3',repository,{'standalone.tar':Buffer.from('other')},{kind:'source'});
    assert.equal(identicalProductPayloads(selected,verifyProductRelease(rebuilt.raw,{product,repository,tag:rebuilt.tag})),false);
    assert.equal(productAssetURL(selected,selected.build.assets[0]),`${repository}/releases/download/${encodeURIComponent(f.tag)}/standalone.tar`);
    assert.deepEqual(await loadProductBlob(selected,'standalone.tar',async url=>{assert.equal(url,productAssetURL(selected,selected.build.assets[0]));return payload},1024),payload);
    await assert.rejects(loadProductBlob(selected,'standalone.tar',async()=>Buffer.alloc(payload.length),1024),/differs/);
    await assert.rejects(loadProductBlob(selected,'missing.tar',async()=>payload,1024),/no missing.tar/);
  }
});

test('later fields are ignored; a newer reader is required by minimum_reader only', () => {
  const f = productFixture('notes','0.6.1-dev.1','https://git.example.test/team/Notes',{'standalone.tar':Buffer.from('x')});
  for (const field of ['source','branch','channel','signatures']) {
    assert.doesNotThrow(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,[field]:'x'}))),field);
    assert.doesNotThrow(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,build_manifest_base64:Buffer.from(JSON.stringify({...f.build,[field]:'x'})).toString('base64')}))),field);
  }
  assert.doesNotThrow(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,build_manifest_base64:Buffer.from(JSON.stringify({...f.build,assets:[{...f.build.assets[0],mirrors:['https://m.test']}]})).toString('base64')}))));
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,minimum_reader:3,build_manifest_base64:'?'}))),ReleaseNeedsNewerReader);
  for (const reader of [0,'1',undefined]) assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,minimum_reader:reader}))),/identity/,String(reader));
  // Both shapes are read: reader 2 without a build name (from 0.6.13), and reader 2 with one.
  const clean = productFixture('notes','0.6.4','https://git.example.test/team/Notes',{'standalone.tar':Buffer.from('x')},{clean:true});
  const parsed = parseProductRelease(clean.raw);
  assert.equal(parsed.release.minimum_reader,2);
  assert.equal(parsed.build.build_version,undefined);
  assert.equal(Object.hasOwn(installedProductProjection(verifyProductRelease(clean.raw,{product:'notes',repository:'https://git.example.test/team/Notes',tag:'v0.6.4'})),'build_version'),false);
  assert.doesNotThrow(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,minimum_reader:2}))));
  // A build name, when present, is still validated.
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,build_manifest_base64:Buffer.from(JSON.stringify({...f.build,build_version:'0.6.1-dev'})).toString('base64')}))),/immutable product build/);
  // Branch-prefixed tags are gone; the tag never names a channel.
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,tag:'dev-v0.6.1-dev.1'}))),/identity/);
  assert.throws(() => parseProductRelease(Buffer.from(f.raw.toString().replace('"sequence":1762950000','"sequence":1,"sequence":1762950000'))),/Duplicate/);
  assert.throws(() => parseProductRelease(Buffer.from(JSON.stringify({...f.release,source_tree:'b'.repeat(40)}))),/another build/);
  const native = productFixture('notes','0.6.1-dev.1','https://git.example.test/team/Notes',{'other.tar':Buffer.from('x')},{primary:'other.tar'});
  assert.throws(() => parseProductRelease(native.raw),/standalone.tar/);
});

test('replay floors are per product and order releases by line and sequence, never by name (no downgrade)', () => {
  const repository = 'https://git.example.test/team/Notes';
  const release = (version: string, payload: string, sequence: number, options: { build?: string; clean?: boolean } = {}) => {
    const f = productFixture('notes',version,repository,{'standalone.tar':Buffer.from(payload)},{sequence,...options});
    return verifyProductRelease(f.raw,{product:'notes',repository,tag:f.tag});
  };
  const current = release('0.6.1-dev.2','a',20);
  const older = release('0.6.1-dev.1','b',10);
  const floors = acceptProductSequence(undefined,current);
  // Both shapes are written: the key (line, sequence) and, for an older Control Panel, the build name.
  assert.deepEqual(floors,{notes:{line:'0.6.1',sequence:20,build:'0.6.1-dev.2',buildSHA256:installedProductProjection(current).build_sha256,manifestSHA256:current.manifestSHA256}});
  assert.deepEqual(acceptProductSequence(floors,current),floors);
  assert.throws(() => acceptProductSequence(floors,older,current),/channel offers notes 0\.6\.1-dev\.1; this box has 0\.6\.1-dev\.2; waiting for the channel to catch up/);
  // Without the installed document the message names the floor's line (never a build name).
  assert.throws(() => acceptProductSequence(floors,older),/channel offers notes 0\.6\.1-dev\.1; this box has 0\.6\.1; waiting/);
  // The same document from another host is the same release.
  const copied = verifyProductRelease(current.raw,{product:'notes',repository:'https://github.com/YouEye-Platform/Notes',tag:'v0.6.1-dev.2'});
  assert.deepEqual(acceptProductSequence(floors,copied),floors);
  // A promoted document: the same build (same sequence) under another name is accepted; only the document changes.
  const alpha = release('0.6.1-alpha.1','a',20,{build:'0.6.1-dev.2'});
  assert.ok(identicalProductPayloads(current,alpha));
  const promoted = acceptProductSequence(floors,alpha);
  assert.deepEqual(promoted.notes,{...floors.notes,manifestSHA256:alpha.manifestSHA256});
  // ...and so is going back to the dev name of that build (e.g. the box changed channel).
  assert.deepEqual(acceptProductSequence(promoted,current),floors);
  // The same key with other contents is refused.
  assert.throws(() => acceptProductSequence(floors,release('0.6.1-alpha.1','other',20)),/other contents/);
  // An older build is refused even under a "higher" release name; labels never decide.
  assert.throws(() => acceptProductSequence(floors,release('0.6.1','b',10,{build:'0.6.1-dev.1'}),current),/offers notes 0\.6\.1; this box has 0\.6\.1-dev\.2/);
  // A newer build under a lower-looking name is accepted.
  assert.equal(acceptProductSequence(floors,release('0.6.1-alpha.2','c',30,{build:'0.6.1-dev.3'})).notes.sequence,30);
  // An older line published later (higher sequence) is still older; a newer line wins whatever its sequence.
  assert.throws(() => acceptProductSequence(floors,release('0.6.0-dev.9','c',99)),/waiting for the channel/);
  assert.equal(acceptProductSequence(floors,release('0.6.2-dev.1','d',5)).notes.line,'0.6.2');
  // A new-shape release (no build name) is ordered the same way; its version stands in for the old field.
  const clean = acceptProductSequence(floors,release('0.6.1','e',40,{clean:true}));
  assert.deepEqual({...clean.notes,buildSHA256:'',manifestSHA256:''},{line:'0.6.1',sequence:40,build:'0.6.1',buildSHA256:'',manifestSHA256:''});
  assert.throws(() => acceptProductSequence(clean,release('0.6.1-dev.9','f',35,{clean:true})),/waiting for the channel/);
  // Floors without a hash are invalid.
  assert.throws(() => acceptProductSequence({notes:{version:'0.6.1-dev.2',sequence:20,manifestSHA256:current.manifestSHA256}} as never,current),/Invalid installed product sequence floor/);
  assert.throws(() => acceptProductSequence({notes:{...floors.notes,line:'0.6.1-dev.2'}},current),/Invalid installed product sequence floor/);
});

test('an older floor (build name only, 0.6.11) is read: its sequence comes from the installed document, else the old build rule decides within its line', () => {
  const repository = 'https://git.example.test/team/Notes';
  const release = (version: string, payload: string, sequence: number, options: { build?: string; clean?: boolean } = {}) => {
    const f = productFixture('notes',version,repository,{'standalone.tar':Buffer.from(payload)},{sequence,...options});
    return verifyProductRelease(f.raw,{product:'notes',repository,tag:f.tag});
  };
  const installed = release('0.6.1','a',20,{build:'0.6.1-dev.2'});
  const old = {notes:{build:'0.6.1-dev.2',buildSHA256:installedProductProjection(installed).build_sha256,manifestSHA256:installed.manifestSHA256}};
  // With the installed document: its key (0.6.1, 20) is the floor's.
  assert.throws(() => acceptProductSequence(old,release('0.6.1-dev.9','b',15),installed),/this box has 0\.6\.1;/);
  const next = acceptProductSequence(old,release('0.6.1-alpha.3','b',25,{build:'0.6.1-dev.1'}),installed);
  assert.deepEqual([next.notes.line,next.notes.sequence,next.notes.build],['0.6.1',25,'0.6.1-dev.1']);
  // Without it: lines first, then the old build rule within the line.
  assert.throws(() => acceptProductSequence(old,release('0.6.0','c',99)),/waiting for the channel/);
  assert.equal(acceptProductSequence(old,release('0.6.2-dev.1','c',1)).notes.line,'0.6.2');
  assert.equal(acceptProductSequence(old,release('0.6.1-beta.1','c',1,{build:'0.6.1-dev.3'})).notes.sequence,1);
  assert.throws(() => acceptProductSequence(old,release('0.6.1-beta.1','c',99,{build:'0.6.1-dev.1'})),/this box has 0\.6\.1; waiting/);
  assert.throws(() => acceptProductSequence(old,release('0.6.1-beta.1','other',20,{build:'0.6.1-dev.2'})),/other contents/);
  // An installed document that is not the one the floor names (a restored older release) is not used.
  const restored = release('0.6.1-dev.1','z',10);
  assert.throws(() => acceptProductSequence(old,release('0.6.1-dev.1','z',10),restored),/this box has 0\.6\.1; waiting/);
});

test('the Market is not a product: a market release document and a catalog build are refused', () => {
  const repository = 'https://github.com/YouEye-Platform/Market';
  // As Market 0.6.4 was released (boxes up to 0.6.10 read it; this reader does not).
  const market = productFixture('market','0.6.4',repository,{'catalog.tar':Buffer.from('tar')},{kind:'catalog' as never,primary:'catalog.tar'});
  const asReleased = Buffer.from(JSON.stringify({...market.release,tag:'catalog-v0.6.4'}));
  assert.throws(() => parseProductRelease(asReleased),/Invalid product release identity/);
  assert.throws(() => verifyProductRelease(asReleased,{product:'market',repository,tag:'catalog-v0.6.4'}),/Invalid product release identity/);
  const catalogKind = productFixture('notes','0.6.4',repository,{'catalog.tar':Buffer.from('tar')},{kind:'catalog' as never,primary:'catalog.tar'});
  assert.throws(() => parseProductRelease(catalogKind.raw),/Invalid immutable product build/);
  assert.equal(productTag('0.6.4'),'v0.6.4');
});
