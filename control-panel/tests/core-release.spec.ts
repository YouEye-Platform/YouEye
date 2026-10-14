import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { parseCoreRelease, verifyCoreRelease, coreArtifactVerificationShell, validCoreBranch, selectedCoreArtifact, loadSelectedCoreDocument } from '../src/lib/releases/core-release';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';

const fixture = readFileSync(new URL('../../releasecache/testdata/core-release-v1.json', import.meta.url));
test('Go and TypeScript consume the same sparse core manifest without relabelling members', () => {
  const r = parseCoreRelease(fixture);
  assert.equal(r.version,'0.5.38');
  assert.equal(r.members.find(m => m.role === 'appliance')?.build_version,'0.5.37');
  assert.equal(r.members.length,14);
  for (const raw of [fixture.toString().replace('"sequence": 2','"sequence": 1, "sequence": 2'), fixture.toString().replace('"state_min": 1','"state_min": 2, "state_min": 1')]) assert.throws(() => parseCoreRelease(Buffer.from(raw)), /Duplicate/);
  const missing = JSON.parse(fixture.toString()); missing.members.pop(); assert.throws(() => parseCoreRelease(Buffer.from(JSON.stringify(missing))), /Incomplete/);
  for (const b of ['Team/Fix','main','f-x']) assert.ok(validCoreBranch(b));
  for (const b of ['x/../main','x@{1}','x.lock','x//y','main\n',' a','x..y']) assert.equal(validCoreBranch(b),false);
});
test('the assembly signature cannot substitute for scoped member authority', () => {
  const pair = generateKeyPairSync('ed25519'), r = parseCoreRelease(fixture);
  const keyHash = createHash('sha256').update(pair.publicKey.export({type:'spki',format:'der'})).digest('hex');
  r.signer_sha256 = keyHash;
  const raw = Buffer.from(JSON.stringify(r)), sig = sign(null,raw,pair.privateKey);
  const policy = publicPolicy as {schema:string;keys:Record<string,string>}, saved = policy.keys;
  policy.keys = {stable:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
  const root = mkdtempSync(join(tmpdir(),'youeye-core-test-'));
  try {
    assert.equal(verifyCoreRelease(raw,sig).version,r.version);
    assert.throws(() => verifyCoreRelease(Buffer.from(JSON.stringify({...r,sequence:3})),sig), /signature/);
    writeFileSync(join(root,'core-release.json'),raw,{mode:0o600});
    writeFileSync(join(root,'core-release.json.sig'),sig,{mode:0o600});
    const ui = r.members.find(m => m.role === 'ui')!;
    assert.throws(() => selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root), /role authority/);
    ui.key_id = keyHash;
    const corrected = Buffer.from(JSON.stringify(r));
    writeFileSync(join(root,'core-release.json'),corrected);
    writeFileSync(join(root,'core-release.json.sig'),sign(null,corrected,pair.privateKey));
    assert.equal(selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root)?.member.role,'ui');
    assert.equal(selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root)?.manifestSHA256, createHash('sha256').update(corrected).digest('hex'));
    assert.throws(() => selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'cp',root), /differs/);
    const shell = coreArtifactVerificationShell({release:r,member:r.members.find(m => m.role === 'ui')!,key:pair.publicKey,manifestSHA256:createHash('sha256').update(corrected).digest('hex')},'/tmp/app.tar');
    assert.match(shell,/openssl pkeyutl -verify/);
    assert.match(shell,/stat -c %s/);
    assert.match(shell,/provenance.json/);
    unlinkSync(join(root,'core-release.json'));
    writeFileSync(join(root,'real-manifest.json'),corrected,{mode:0o600});
    symlinkSync(join(root,'real-manifest.json'),join(root,'core-release.json'));
    assert.throws(() => loadSelectedCoreDocument(root));
  } finally { policy.keys = saved; rmSync(root,{recursive:true}); }
});

test('a Beta group retains the Stable key of its exact reused UI', () => {
  const stable = generateKeyPairSync('ed25519'), beta = generateKeyPairSync('ed25519');
  const fingerprint = (key: typeof stable.publicKey) => createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  const policy = publicPolicy as {schema:string;keys:Record<string,string>}, saved = policy.keys;
  policy.keys = { stable:stable.publicKey.export({type:'spki',format:'pem'}).toString(), beta:beta.publicKey.export({type:'spki',format:'pem'}).toString() };
  const r = parseCoreRelease(fixture), ui = r.members.find(m => m.role === 'ui')!;
  r.version = '0.5.39-beta.1'; r.tag = `youeye-v${r.version}`; r.branch = 'beta'; r.channel = 'beta'; r.signer_sha256 = fingerprint(beta.publicKey);
  ui.key_id = fingerprint(stable.publicKey);
  const root = mkdtempSync(join(tmpdir(),'youeye-core-reuse-'));
  const save = () => { const raw = Buffer.from(JSON.stringify(r)); writeFileSync(join(root,'core-release.json'),raw,{mode:0o600}); writeFileSync(join(root,'core-release.json.sig'),sign(null,raw,beta.privateKey),{mode:0o600}); };
  try {
    save();
    const selected = selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root)!;
    assert.equal(fingerprint(selected.key),fingerprint(stable.publicKey));
    assert.equal(selected.member.branch,'main');
    ui.key_id = fingerprint(beta.publicKey); save();
    assert.throws(() => selectedCoreArtifact(ui.artifact.url,ui.artifact.sha256,'ui',root), /role authority/);
  } finally { policy.keys = saved; rmSync(root,{recursive:true}); }
});
