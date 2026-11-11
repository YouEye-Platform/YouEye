import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCoreRelease, coreArtifactVerificationShell, validCoreBranch, selectedCoreArtifact, selectedCoreRole, loadSelectedCoreDocument, verifyCoreArtifactBuffer, coreBlobTransportURL } from '../src/lib/releases/core-release';
import { releaseArtifactVerificationShell, verifyReleaseArtifactBuffer } from '../src/lib/releases/artifact';

const fixture = readFileSync(new URL('../../releasecache/testdata/core-release-v1.json', import.meta.url));
const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const mutate = (change: (r: any) => void) => { const r = JSON.parse(fixture.toString()); change(r); return Buffer.from(JSON.stringify(r)); };

test('the unsigned core release document is strict and has one interpretation', () => {
  const r = parseCoreRelease(fixture);
  assert.equal(r.version,'0.5.38');
  assert.equal(r.authority,'digest');
  assert.equal(r.members.find(m => m.role === 'appliance')?.build_version,'0.5.37');
  assert.equal(r.members.find(m => m.role === 'appliance')?.build_inputs?.name,'build-inputs.json');
  assert.equal(r.members.length,14);
  for (const raw of [fixture.toString().replace('"sequence": 2','"sequence": 1, "sequence": 2'), fixture.toString().replace('"state_min": 1','"state_min": 2, "state_min": 1')]) assert.throws(() => parseCoreRelease(Buffer.from(raw)), /Duplicate/);
  assert.throws(() => parseCoreRelease(mutate(r => r.members.pop())), /Incomplete/);
  assert.throws(() => parseCoreRelease(mutate(r => { delete r.authority; })), /identity/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.authority = 'signature'; })), /identity/);
  // Removed signature fields are unknown fields now, never silently accepted.
  assert.throws(() => parseCoreRelease(mutate(r => { r.unexpected = true; })), /fields/);
  for (const field of ['checksums','signature','provenance','sbom','key_id','document_signature','release_lock']) {
    assert.throws(() => parseCoreRelease(mutate(r => { r.members[0][field] = r.members[0].artifact; })), /fields/, field);
  }
  assert.throws(() => parseCoreRelease(mutate(r => { delete r.members.find((m: any) => m.role === 'appliance').build_inputs; })), /build inputs/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.members.find((m: any) => m.role === 'ui').build_inputs = r.members[0].artifact; })), /build inputs/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.members[0].artifact.url = 'https://github.com/YouEye-Platform/YouEye/releases/download/other/x'; })), /blob/);
  assert.throws(() => parseCoreRelease(mutate(r => { r.members[0].artifact.size_bytes = 1.5; })), /integer/);
  for (const b of ['Team/Fix','main','f-x']) assert.ok(validCoreBranch(b));
  for (const b of ['x/../main','x@{1}','x.lock','x//y','main\n',' a','x..y']) assert.equal(validCoreBranch(b),false);
});

test('CP/UI artifacts bind by digest and size to the selection Spine accepted', () => {
  const root = mkdtempSync(join(tmpdir(),'youeye-core-test-'));
  try {
    const payload = Buffer.from('ui standalone payload');
    const raw = mutate(r => { const ui = r.members.find((m: any) => m.role === 'ui'); ui.artifact.sha256 = sha(payload); ui.artifact.size_bytes = payload.length; });
    writeFileSync(join(root,'core-release.json'),raw,{mode:0o600});
    const ui = parseCoreRelease(raw).members.find(m => m.role === 'ui')!;
    const selected = selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root)!;
    assert.equal(selected.member.role,'ui');
    assert.equal(selected.manifestSHA256,sha(raw));
    assert.equal(selectedCoreRole('ui',root).member.artifact.name,ui.artifact.name);
    assert.throws(() => selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'cp',root), /differs/);
    assert.throws(() => selectedCoreArtifact(ui.artifact.url,'f'.repeat(64),'ui',root), /differs/);
    assert.equal(selectedCoreArtifact('https://forge.example.test/a/b/releases/download/ui-v1.0.0/standalone.tar','f'.repeat(64),'ui',root),null);
    assert.equal(verifyCoreArtifactBuffer(selected,payload),sha(payload));
    assert.throws(() => verifyCoreArtifactBuffer(selected,Buffer.from('tampered payload!!!!!')), /differs/);
    assert.throws(() => verifyCoreArtifactBuffer(selected,Buffer.concat([payload,Buffer.from('x')])), /differs/);
    const shell = coreArtifactVerificationShell(selected,'/tmp/app.tar');
    assert.match(shell,/stat -c %s/);
    assert.match(shell,new RegExp(sha(payload)));
    assert.doesNotMatch(shell,/openssl|curl/);
    assert.equal(coreBlobTransportURL(selected.release,ui.artifact),ui.artifact.url);
    assert.equal(coreBlobTransportURL(selected.release,ui.artifact,true),`${selected.release.source}/releases/download/${selected.release.tag}/blob-${sha(payload)}`);
    assert.throws(() => coreBlobTransportURL(selected.release,{...ui.artifact,sha256:'f'.repeat(64)}), /outside/);
    unlinkSync(join(root,'core-release.json'));
    writeFileSync(join(root,'real-manifest.json'),raw,{mode:0o600});
    symlinkSync(join(root,'real-manifest.json'),join(root,'core-release.json'));
    assert.throws(() => loadSelectedCoreDocument(root));
  } finally { rmSync(root,{recursive:true}); }
});

test('non-core artifacts are checked against their pinned digest only', () => {
  const url = 'https://forge.example.test/a/b/releases/download/ui-dev-v1.0.0/standalone.tar';
  const bytes = Buffer.from('component');
  assert.equal(verifyReleaseArtifactBuffer(url,bytes,sha(bytes)),sha(bytes));
  assert.equal(verifyReleaseArtifactBuffer(url,bytes),sha(bytes));
  assert.throws(() => verifyReleaseArtifactBuffer(url,Buffer.from('tampered'),sha(bytes)), /channel digest/);
  assert.throws(() => verifyReleaseArtifactBuffer(url,bytes,'not-a-digest'), /malformed/);
  const shell = releaseArtifactVerificationShell(url,'/tmp/app.tar',sha(bytes));
  assert.match(shell,/sha256sum/);
  assert.match(shell,new RegExp(sha(bytes)));
  assert.doesNotMatch(shell,/openssl|SHA256SUMS|\.pub/);
  assert.doesNotMatch(releaseArtifactVerificationShell(url,'/tmp/app.tar'),/sha256sum/);
});
