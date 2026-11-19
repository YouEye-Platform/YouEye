import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalReleaseRepository, ReleaseNeedsNewerReader, parseCoreRelease, coreArtifactVerificationShell, releaseAssetURL, selectedCoreRole, loadSelectedCoreDocument, verifyCoreArtifactBuffer } from '../src/lib/releases/core-release';
import { releaseArtifactVerificationShell, releaseDownloadShell, verifyReleaseArtifactBuffer } from '../src/lib/releases/artifact';

// The same fixtures the Go reader (releasecache) parses: one document, one interpretation.
// core-release.json is the old shape (0.6.11/0.6.12: `build`, member `build_version`, reader 1);
// core-release-no-build.json the new one (0.6.13: neither, reader 2, line `minimum_release`).
const fixture = readFileSync(new URL('../../releasecache/testdata/core-release.json', import.meta.url));
const clean = readFileSync(new URL('../../releasecache/testdata/core-release-no-build.json', import.meta.url));
const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const mutate = (change: (r: any) => void) => { const r = JSON.parse(fixture.toString()); change(r); return Buffer.from(JSON.stringify(r)); };

test('the shared host-independent core release fixture parses strictly', () => {
  const r = parseCoreRelease(fixture);
  assert.equal(r.version,'0.6.1-dev.1');
  assert.equal(r.tag,'youeye-v0.6.1-dev.1');
  assert.equal(r.build,'0.6.1-dev.1');
  assert.match(r.source_tree,/^[0-9a-f]{40}$/);
  assert.equal(r.authority,'digest');
  assert.equal(r.members.length,13);
  assert.equal(r.members.find(m => m.role === 'appliance')?.build_inputs?.name,'build-inputs.json');
  for (const member of r.members) {
    assert.match(member.source_tree,/^[0-9a-f]{40}$/);
    assert.equal(Object.hasOwn(member.artifact,'url'),false);
  }
  for (const raw of [fixture.toString().replace('"sequence": 1762950000','"sequence": 1, "sequence": 1762950000'), fixture.toString().replace('"state_min": 1','"state_min": 2, "state_min": 1')]) assert.throws(() => parseCoreRelease(Buffer.from(raw)), /Duplicate/);
  assert.throws(() => parseCoreRelease(mutate(r => r.members.pop())), /Incomplete/);
  assert.throws(() => parseCoreRelease(mutate(r => { delete r.authority; })), /identity/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.source_tree = 'abc'; })), /identity/);
  // `build` is optional (the old shape), validated when present, never used.
  assert.doesNotThrow(() => parseCoreRelease(mutate(r => { delete r.build; })));
  for (const build of ['', '0.6.1-dev', 'v0.6.1-dev.1', 1]) assert.throws(() => parseCoreRelease(mutate(r => { r.build = build; })), /identity/, String(build));
  // Member build versions likewise.
  assert.doesNotThrow(() => parseCoreRelease(mutate(r => { for (const m of r.members) delete m.build_version; })));
  for (const build of ['', '0.6.1-dev', 1]) assert.throws(() => parseCoreRelease(mutate(r => { r.members[0].build_version = build; })), /member/, String(build));
  // A promoted document: another name and tag for the same build.
  const promoted = parseCoreRelease(mutate(r => { r.version = '0.6.1-beta.1'; r.tag = 'youeye-v0.6.1-beta.1'; }));
  assert.equal(promoted.version,'0.6.1-beta.1');
  assert.equal(promoted.build,'0.6.1-dev.1');
  assert.throws(() => parseCoreRelease(mutate(r => { r.members[0].source_tree = 'x'.repeat(40); })), /member/);
  // Fields a later release may add are ignored (covered by the digest, never used).
  for (const field of ['source','branch','channel','signatures']) {
    assert.doesNotThrow(() => parseCoreRelease(mutate(r => { r[field] = 'x'; })), field);
  }
  assert.doesNotThrow(() => parseCoreRelease(mutate(r => { r.members[0].sbom = 'x'; r.members[0].artifact.mirrors = ['https://m.test']; })));
  // A higher reader or an unknown role is "needs a newer reader", not an invalid document.
  assert.throws(() => parseCoreRelease(mutate(r => { r.minimum_reader = 3; r.members = 'another shape'; })), ReleaseNeedsNewerReader);
  for (const reader of [0, 1.5, '1', undefined]) assert.throws(() => parseCoreRelease(mutate(r => { r.minimum_reader = reader; })), /identity|integer/, String(reader));
  assert.throws(() => parseCoreRelease(mutate(r => { r.members.push({ ...r.members[0], role: 'firmware' }); })), ReleaseNeedsNewerReader);
  assert.throws(() => parseCoreRelease(mutate(r => { r.members.shift(); })), /Incomplete core membership/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.schema = 'youeye.core-release.v2'; })), /schema/);
  assert.throws(() => parseCoreRelease(mutate(r => { delete r.members.find((m: any) => m.role === 'appliance').build_inputs; })), /build inputs/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.members[0].artifact.size_bytes = 1.5; })), /integer/);
  // A blob may live in another youeye-v release of the same repository, nothing else.
  assert.doesNotThrow(() => parseCoreRelease(mutate(r => { r.members[4].artifact.release = 'youeye-v0.6.0-dev.3'; })));
  assert.throws(() => parseCoreRelease(mutate(r => { r.members[4].artifact.release = 'v0.6.0'; })), /blob/);
});

test('the new shape (no build names, reader 2, a line as minimum_release) parses like the old one', () => {
  const r = parseCoreRelease(clean), old = parseCoreRelease(fixture);
  assert.equal(r.version, '0.6.13');
  assert.equal(r.tag, 'youeye-v0.6.13');
  assert.equal(r.minimum_reader, 2);
  assert.equal(r.build, undefined);
  assert.equal(r.compatibility.minimum_release, '0.6.12');
  assert.equal(r.members.length, old.members.length);
  for (const member of r.members) assert.equal(member.build_version, undefined);
  // A reader-2 document with build names is still read (they are ignored).
  assert.doesNotThrow(() => parseCoreRelease(mutate(d => { d.minimum_reader = 2; })));
});

test('assets are located only by repository, tag and name', () => {
  const r = parseCoreRelease(fixture);
  const repository = canonicalReleaseRepository('https://git.example.test/owner/YouEye');
  const ui = r.members.find(m => m.role === 'ui')!;
  assert.equal(releaseAssetURL(repository, r.tag, ui.artifact), `https://git.example.test/owner/YouEye/releases/download/youeye-v0.6.1-dev.1/${ui.artifact.name}`);
  assert.equal(releaseAssetURL(repository, r.tag, {...ui.artifact, release:'youeye-v0.6.0-dev.2'}), `https://git.example.test/owner/YouEye/releases/download/youeye-v0.6.0-dev.2/${ui.artifact.name}`);
  for (const bad of ['http://x.test/a/b','https://x.test/a','https://x.test/a/b/c','https://u:p@x.test/a/b','https://x.test/a/b?x=1']) {
    assert.throws(() => canonicalReleaseRepository(bad), undefined, bad);
  }
  assert.match(releaseDownloadShell(releaseAssetURL(repository, r.tag, ui.artifact), '/tmp/app.tar'), /--proto '=https'/);
  assert.throws(() => releaseDownloadShell('https://api.github.com/repos/a/b/releases', '/tmp/x'), /release assets/);
});

test('CP/UI artifacts bind by digest and size to the selection Spine accepted', () => {
  const root = mkdtempSync(join(tmpdir(),'youeye-core-test-'));
  try {
    const payload = Buffer.from('ui standalone payload');
    const raw = mutate(r => { const ui = r.members.find((m: any) => m.role === 'ui'); ui.artifact.sha256 = sha(payload); ui.artifact.size_bytes = payload.length; });
    writeFileSync(join(root,'core-release.json'),raw,{mode:0o600});
    const selected = selectedCoreRole('ui',root);
    assert.equal(selected.member.role,'ui');
    assert.equal(selected.manifestSHA256,sha(raw));
    assert.equal(verifyCoreArtifactBuffer(selected,payload),sha(payload));
    assert.throws(() => verifyCoreArtifactBuffer(selected,Buffer.from('tampered payload!!!!!')), /differs/);
    assert.throws(() => verifyCoreArtifactBuffer(selected,Buffer.concat([payload,Buffer.from('x')])), /differs/);
    const shell = coreArtifactVerificationShell(selected,'/tmp/app.tar');
    assert.match(shell,/stat -c %s/);
    assert.match(shell,new RegExp(sha(payload)));
    unlinkSync(join(root,'core-release.json'));
    writeFileSync(join(root,'real-manifest.json'),raw,{mode:0o600});
    symlinkSync(join(root,'real-manifest.json'),join(root,'core-release.json'));
    assert.throws(() => loadSelectedCoreDocument(root));
  } finally { rmSync(root,{recursive:true}); }
});

test('release artifacts are checked against the exact document digest and size', () => {
  const bytes = Buffer.from('component');
  assert.equal(verifyReleaseArtifactBuffer(bytes,{sha256:sha(bytes),size_bytes:bytes.length}),sha(bytes));
  assert.equal(verifyReleaseArtifactBuffer(bytes),sha(bytes));
  assert.throws(() => verifyReleaseArtifactBuffer(Buffer.from('tampered'),{sha256:sha(bytes)}), /digest/);
  assert.throws(() => verifyReleaseArtifactBuffer(bytes,{sha256:sha(bytes),size_bytes:bytes.length + 1}), /digest/);
  assert.throws(() => verifyReleaseArtifactBuffer(bytes,{sha256:'not-a-digest'}), /malformed/);
  const shell = releaseArtifactVerificationShell('/tmp/app.tar',{sha256:sha(bytes),size_bytes:9});
  assert.match(shell,/sha256sum/);
  assert.match(shell,/stat -c %s/);
  assert.match(shell,new RegExp(sha(bytes)));
  assert.doesNotMatch(releaseArtifactVerificationShell('/tmp/app.tar'),/sha256sum/);
});
