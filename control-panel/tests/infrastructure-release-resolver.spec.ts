import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ReleaseSource } from '../src/lib/apps/release-source';
import {
  listInfrastructureReleases,
  resolveInfrastructureStandaloneRelease,
  resolveExactInfrastructureStandaloneRelease,
  selectExactInfrastructureStandaloneRelease,
  selectInfrastructureStandaloneRelease,
  type InfrastructureRelease,
} from '../src/lib/infrastructure/release-resolver';

const forgejo: ReleaseSource = {
  provider: 'gitea',
  base_url: 'https://forge.example.test',
  api_path: '/api/v1',
  organization: 'youeye',
};

test('infrastructure release discovery paginates beyond the first 50 Forgejo releases', async () => {
  const calls: string[] = [];
  const firstPage: InfrastructureRelease[] = Array.from({ length: 50 }, (_, index) => ({
    tag_name: `cp-f-unrelated-v0.0.${index}`,
    assets: [],
  }));
  const secondPage: InfrastructureRelease[] = [{
    tag_name: 'ui-v0.5.3',
    assets: [{
      name: 'standalone.tar',
      uuid: 'ui-asset-page-two',
      browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/ui-v0.5.3/standalone.tar',
    }],
  }];
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const page = new URL(url).searchParams.get('page');
    return new Response(JSON.stringify(page === '1' ? firstPage : secondPage), { status: 200 });
  };

  const resolved = await resolveInfrastructureStandaloneRelease(
    forgejo,
    'YouEye',
    'ui',
    'f-installer-deploy-recovery',
    fakeFetch as typeof fetch,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0], /limit=50&page=1/);
  assert.match(calls[1], /limit=50&page=2/);
  assert.equal(resolved.tag, 'ui-v0.5.3');
  assert.equal(resolved.url, 'https://forge.example.test/youeye/YouEye/releases/download/ui-v0.5.3/standalone.tar');
});

test('release selection keeps branch semantics and requires standalone.tar', () => {
  const releases: InfrastructureRelease[] = [
    {
      tag_name: 'ui-f-installer-deploy-recovery-v0.5.2.0.0.1',
      assets: [{
        name: 'standalone.tar',
        uuid: 'feature',
        browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/ui-f-installer-deploy-recovery-v0.5.2.0.0.1/standalone.tar',
      }],
    },
    {
      tag_name: 'ui-v0.5.1',
      assets: [{
        name: 'standalone.tar',
        uuid: 'stable',
        browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/ui-v0.5.1/standalone.tar',
      }],
    },
    {
      tag_name: 'ui-f-installer-deploy-recovery-v9.9.9',
      assets: [{ name: 'wrong-asset.tar', uuid: 'wrong' }],
    },
  ];

  const resolved = selectInfrastructureStandaloneRelease(
    forgejo,
    releases,
    'ui',
    'f-installer-deploy-recovery',
  );
  assert.equal(resolved?.tag, 'ui-f-installer-deploy-recovery-v0.5.2.0.0.1');
  assert.equal(resolved?.url, 'https://forge.example.test/youeye/YouEye/releases/download/ui-f-installer-deploy-recovery-v0.5.2.0.0.1/standalone.tar');
});

test('Forgejo browser download URL wins over UUID for signed Control Panel LXD updates', () => {
  const resolved = selectInfrastructureStandaloneRelease(
    forgejo,
    [{
      tag_name: 'cp-v0.5.22.0.3',
      assets: [{
        name: 'standalone.tar',
        uuid: 'opaque-control-panel-asset',
        browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/cp-v0.5.22.0.3/standalone.tar',
      }],
    }],
    'cp',
    'main',
  );

  assert.equal(resolved?.url, 'https://forge.example.test/youeye/YouEye/releases/download/cp-v0.5.22.0.3/standalone.tar');
});

test('Forgejo UUID-only assets are ineligible because signed metadata has no safe sibling URL', () => {
  const resolved = selectInfrastructureStandaloneRelease(
    forgejo,
    [{
      tag_name: 'ui-v0.5.3.0.3',
      assets: [{ name: 'standalone.tar', uuid: 'opaque-ui-asset' }],
    }],
    'ui',
    'main',
  );

  assert.equal(resolved, null);
});

test('exact UI first deploy freezes the signed tag and configured artifact digest', () => {
  const digest = 'a'.repeat(64);
  const resolved = selectExactInfrastructureStandaloneRelease(
    forgejo,
    [
      {
        tag_name: 'ui-f-candidate-v0.5.3.0.4',
        assets: [{
          name: 'standalone.tar',
          browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/ui-f-candidate-v0.5.3.0.4/standalone.tar',
        }],
      },
      {
        tag_name: 'ui-f-candidate-v9.9.9',
        assets: [{
          name: 'standalone.tar',
          browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/ui-f-candidate-v9.9.9/standalone.tar',
        }],
      },
    ],
    'ui-f-candidate-v0.5.3.0.4',
    digest,
  );

  assert.equal(resolved?.tag, 'ui-f-candidate-v0.5.3.0.4');
  assert.equal(resolved?.artifactSHA256, digest);
  assert.match(resolved?.url || '', /ui-f-candidate-v0\.5\.3\.0\.4\/standalone\.tar$/);
  assert.equal(selectExactInfrastructureStandaloneRelease(forgejo, [], 'ui-f-candidate-v0.5.3.0.4', digest), null);
  assert.equal(selectExactInfrastructureStandaloneRelease(forgejo, [], 'ui-f-candidate-v0.5.3.0.4', 'BAD'), null);
});

test('exact signed UI release preserves an encoded multi-segment branch tag', () => {
  const tag = 'ui-codex/phase1-repository-builds-v0.5.3.0.4';
  const digest = 'c'.repeat(64);
  const resolved = selectExactInfrastructureStandaloneRelease(
    forgejo,
    [{
      tag_name: tag,
      assets: [{
        name: 'standalone.tar',
        browser_download_url: 'https://forge.example.test/youeye/YouEye/releases/download/ui-codex%2Fphase1-repository-builds-v0.5.3.0.4/standalone.tar',
      }],
    }],
    tag,
    digest,
  );
  assert.equal(resolved?.tag, tag);
  assert.equal(resolved?.artifactSHA256, digest);
});

test('signed infrastructure releases reject cross-origin, wrong-name, and non-release browser URLs', () => {
  for (const browser_download_url of [
    'https://evil.example/youeye/YouEye/releases/download/ui-v0.5.3.0.3/standalone.tar',
    'https://forge.example.test/youeye/YouEye/releases/download/ui-v0.5.3.0.3/wrong.tar',
    'https://forge.example.test/attachments/opaque-ui-asset',
    'https://forge.example.test/youeye/YouEye/releases/download/ui-v0.5.3.0.3%2fescape/standalone.tar',
  ]) {
    const resolved = selectInfrastructureStandaloneRelease(
      forgejo,
      [{
        tag_name: 'ui-v0.5.3.0.3',
        assets: [{ name: 'standalone.tar', browser_download_url }],
      }],
      'ui',
      'main',
    );
    assert.equal(resolved, null);
  }
});

test('release listing fails loudly on a non-array response', async () => {
  const fakeFetch = async () => new Response('{"message":"rate limited"}', { status: 200 });
  await assert.rejects(
    listInfrastructureReleases(forgejo, 'YouEye', fakeFetch as typeof fetch),
    /did not return an array/,
  );
});

test('system UI never claims a raw host port', async () => {
  const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
  const deployer = await readFile(join(root, 'src/lib/infrastructure/deployer.ts'), 'utf8');
  const lxdDeployer = await readFile(join(root, 'src/lib/infrastructure/lxd-deployer.ts'), 'utf8');
  assert.match(deployer, /tagPrefix: 'ui',[\s\S]*exposeHostPort: false/);
  assert.match(deployer, /recordCoreProvenance\('ui',[\s\S]*artifactSHA256: resolved\.artifactSHA256/);
  assert.match(deployer, /exactUIProvenanceMatchesConfiguredSource[\s\S]*provenance\.artifact_sha256 === channel\.artifact_sha256/);
  assert.match(deployer, /exactUIProvenanceMatchesConfiguredSource\(\)\) === false[\s\S]*deployUIContainerFromConfiguredSource\(true\)/);
  assert.match(lxdDeployer, /spec\.port && cfg\.exposeHostPort !== false/);
});

test('digest-pinned UI resolution does not consult an exhausted API', async () => {
  const failFetch = async () => { throw new Error('API must not be requested'); };
  const result = await resolveExactInfrastructureStandaloneRelease(forgejo, 'YouEye', 'ui-v0.5.5', 'a'.repeat(64), failFetch as typeof fetch);
  assert.equal(result.url, 'https://forge.example.test/youeye/YouEye/releases/download/ui-v0.5.5/standalone.tar');
  await assert.rejects(resolveExactInfrastructureStandaloneRelease(forgejo, 'YouEye', '../bad', 'a'.repeat(64), failFetch as typeof fetch));
  await assert.rejects(resolveExactInfrastructureStandaloneRelease(forgejo, 'YouEye', 'ui-v0.5.5', 'BAD', failFetch as typeof fetch));
});

test('exact Pointer deployment accepts its signed unprefixed tag without API discovery', async () => {
  const source: ReleaseSource = { provider: 'github', base_url: 'https://github.com', api_path: '', organization: 'YouEye-Platform' };
  const failFetch = async () => { throw new Error('API must not be requested'); };
  const result = await resolveExactInfrastructureStandaloneRelease(source, 'Pointer', 'v0.5.1', 'a'.repeat(64), failFetch as typeof fetch);
  assert.equal(result.version, '0.5.1');
  assert.equal(result.url, 'https://github.com/YouEye-Platform/Pointer/releases/download/v0.5.1/standalone.tar');
  await assert.rejects(resolveExactInfrastructureStandaloneRelease(source, 'Pointer', 'vnot-a-version', 'a'.repeat(64), failFetch as typeof fetch));
});

test('default infrastructure discovery uses protected release transport with the provider API unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infrastructure-release-cache-'));
  const previousRoot = process.env.YOUEYE_RELEASE_CACHE;
  const previousFetch = globalThis.fetch;
  const source: ReleaseSource = { provider: 'github', base_url: 'https://github.com', api_path: '', organization: 'YouEye-Platform' };
  const payload = Buffer.from(JSON.stringify([{ tag_name: 'v0.5.2', assets: [{ name: 'standalone.tar', browser_download_url: 'https://github.com/YouEye-Platform/Pointer/releases/download/v0.5.2/standalone.tar' }] }]));
  const digest = createHash('sha256').update(payload).digest('hex');
  try {
    await mkdir(join(root, 'objects'));
    await writeFile(join(root, 'objects', digest), payload, { mode: 0o600 });
    await writeFile(join(root, 'index.json'), JSON.stringify({ schema: 'youeye.release-cache.v1', objects: { 'https://api.github.com/repos/YouEye-Platform/Pointer/releases?per_page=50&page=1': { sha256: digest, bytes: payload.length } } }), { mode: 0o600 });
    process.env.YOUEYE_RELEASE_CACHE = root;
    globalThis.fetch = async () => { throw new Error('Direct provider API is unavailable'); };
    assert.equal((await resolveInfrastructureStandaloneRelease(source, 'Pointer', '', 'main')).tag, 'v0.5.2');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.YOUEYE_RELEASE_CACHE; else process.env.YOUEYE_RELEASE_CACHE = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
