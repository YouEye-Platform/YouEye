import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { stageMarketNativeArtifact } from '../src/lib/market/native-artifact';
import { OWNER_TRUST_PATH, OWNER_TRUST_SCHEMA } from '../src/lib/releases/owner-trust';
import { ContainerSchema } from '../src/lib/market/schema';
import { parseMarketRepoURL } from '../src/lib/market/source';

test('Forgejo signed native staging uses exact release attachments without relaxing publisher trust', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-forgejo-stage-'));
  const originalRead = fs.readFileSync;
  const originalFetch = globalThis.fetch;
  const pair = generateKeyPairSync('ed25519');
  const key = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const repo = 'https://forge.example/alice/App';
  let revoked = false;
  t.mock.method(fs, 'readFileSync', ((path: unknown, ...args: unknown[]) => {
    if (path === OWNER_TRUST_PATH) return Buffer.from(JSON.stringify({ schema: OWNER_TRUST_SCHEMA, grants: [
      { publisher: 'Test', repository: repo, branch: 'main', scope: 'app', public_key: key, revoked },
    ] }));
    return (originalRead as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof originalRead);
  syncBuiltinESMExports();
  try {
    await mkdir(join(root, 'payload'));
    await writeFile(join(root, 'payload/server.js'), 'console.log("ready")');
    await promisify(execFile)('tar', ['-cf', join(root, 'fixture.tar'), '-C', join(root, 'payload'), '.']);
    const bytes = await readFile(join(root, 'fixture.tar'));
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
    const sums = Buffer.from(`${sha(bytes)}  standalone.tar\n${sha(key)}  release-development.pub\n${'a'.repeat(64)}  provenance.json\n${'b'.repeat(64)}  sbom.spdx.json\n`);
    const contents = new Map<string, Buffer>([
      ['standalone.tar', bytes], ['release-development.pub', Buffer.from(key)],
      ['SHA256SUMS', sums], ['SHA256SUMS.sig', sign(null, sums, pair.privateKey)],
      ['provenance.json', Buffer.from('{}')], ['sbom.spdx.json', Buffer.from('{}')],
    ]);
    const base = `${repo}/releases/download/v1.2.3/`;
    const validAssets = [...contents.keys()].map((name, i) => ({ name, browser_download_url: base + name,
      uuid: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}` }));
    let assets = structuredClone(validAssets);
    const calls: string[] = [];
    let redirect = '';
    globalThis.fetch = async input => {
      const url = String(input); calls.push(url);
      if (url.startsWith('https://forge.example/api/v1/repos/alice/App/releases')) {
        return Response.json([{ tag_name: 'v1.2.3', assets }]);
      }
      const asset = validAssets.find(a => url === `https://forge.example/attachments/${a.uuid}`);
      if (asset) {
        if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
        return new Response(new Uint8Array(contents.get(asset.name)!));
      }
      if (url.startsWith(base)) return new Response('<html>Repository</html>', { headers: { 'content-type': 'text/html' } });
      throw new Error('Unexpected request ' + url);
    };
    const container = ContainerSchema.parse({ name: 'main', type: 'lxd', image: 'debian/12', source: { repo: 'alice/App' }, port: 3000 });
    const source = parseMarketRepoURL('https://forge.example/alice/Market');
    const stage = () => stageMarketNativeArtifact(root, container, source);
    assert.equal((await stage()).signature.status, 'verified-custom');
    assert.equal(calls.some(url => url.startsWith(base)), false);
    assert.equal(calls.filter(url => url.includes('/attachments/')).length, 4);
    contents.set('standalone.tar', Buffer.from('tampered'));
    await assert.rejects(stage(), /signature or checksum/); contents.set('standalone.tar', bytes);
    const goodSignature = contents.get('SHA256SUMS.sig')!;
    contents.set('SHA256SUMS.sig', Buffer.alloc(64));
    await assert.rejects(stage(), /signature or checksum/); contents.set('SHA256SUMS.sig', goodSignature);
    contents.set('release-development.pub', Buffer.from('untrusted'));
    await assert.rejects(stage(), /signature or checksum/); contents.set('release-development.pub', Buffer.from(key));
    assets[2].browser_download_url = base.replace('/App/', '/Other/') + assets[2].name;
    await assert.rejects(stage(), /signature or checksum/); assets = structuredClone(validAssets);
    assets[2].browser_download_url = base.replace('/v1.2.3/', '/v1.2.2/') + assets[2].name;
    await assert.rejects(stage(), /signature or checksum/); assets = structuredClone(validAssets);
    assets.push({ ...assets[0] }); await assert.rejects(stage(), /ambiguous/); assets = structuredClone(validAssets);
    assets[0].uuid = '../outside'; await assert.rejects(stage(), /attachment identity/); assets = structuredClone(validAssets);
    contents.set('SHA256SUMS', Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(stage(), /signature or checksum/); contents.set('SHA256SUMS', sums);
    redirect = 'https://attacker.example/asset';
    await assert.rejects(stage(), /outside its release source/); redirect = '';
    revoked = true; await assert.rejects(stage(), /revoked/); revoked = false;
    assets = validAssets.filter(a => a.name !== 'SHA256SUMS.sig');
    await assert.rejects(stage(), /incomplete signature bundle/);
    assets = validAssets.filter(a => a.name === 'standalone.tar');
    await assert.rejects(stage(), /requires its enrolled publisher signature/);
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((await stage()).signature.status, 'unsigned');
  } finally {
    globalThis.fetch = originalFetch;
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
