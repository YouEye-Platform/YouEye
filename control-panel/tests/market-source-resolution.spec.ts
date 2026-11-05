import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MARKET_REPO_URL,
  getMarketReleaseAssetDownloadURL,
  migrateLegacyOfficialSource,
  parseMarketRepoURL,
  resolveMarketSourceCommit,
} from '../src/lib/market/source';

test('official appliance bootstrap commit migrates to main while retaining last-known-good identity', () => {
  const commit = '7251b1587a724b74fa6e449acc79e2ec210b7df3';
  const migrated = migrateLegacyOfficialSource(parseMarketRepoURL(DEFAULT_MARKET_REPO_URL, {
    id: 'official',
    trust: 'official',
    branch: commit,
  }));

  assert.equal(migrated.branch, 'main');
  assert.equal(migrated.resolved_commit, commit);
  assert.equal(migrated.bootstrap_commit, commit);
});

test('published appliance bootstrap commits migrate while arbitrary administrator pins remain exact', () => {
  const historical = '470fb7aaeb57fc273efa8464ce22ea072cf3858e';
  const migratedHistorical = migrateLegacyOfficialSource(parseMarketRepoURL(DEFAULT_MARKET_REPO_URL, {
    id: 'official',
    trust: 'official',
    branch: historical,
    resolved_commit: historical,
  }));
  assert.equal(migratedHistorical.branch, 'main');
  assert.equal(migratedHistorical.resolved_commit, historical);
  assert.equal(migratedHistorical.bootstrap_commit, historical);

  const declaredBootstrap = '2222222222222222222222222222222222222222';
  const migratedDeclared = migrateLegacyOfficialSource(parseMarketRepoURL(DEFAULT_MARKET_REPO_URL, {
    id: 'official',
    trust: 'official',
    branch: declaredBootstrap,
    bootstrap_commit: declaredBootstrap,
  }));
  assert.equal(migratedDeclared.branch, 'main');
  assert.equal(migratedDeclared.resolved_commit, declaredBootstrap);
});

test('administrator-selected commit pins are not migrated', () => {
  const commit = '1111111111111111111111111111111111111111';
  const pinned = migrateLegacyOfficialSource(parseMarketRepoURL(DEFAULT_MARKET_REPO_URL, {
    id: 'official',
    trust: 'official',
    branch: commit,
  }));
  assert.equal(pinned.branch, commit);
  assert.equal(pinned.resolved_commit, undefined);
});

test('official GitHub Market channel resolves to an exact commit', async () => {
  const source = parseMarketRepoURL(DEFAULT_MARKET_REPO_URL, { branch: 'main' });
  let requested = '';
  const commit = '60afd558dd378307d8c11c2d1b15d112cd42d3ea';
  const fakeFetch = async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ sha: commit }), { status: 200 });
  };

  assert.equal(await resolveMarketSourceCommit(source, fakeFetch as typeof fetch), commit);
  assert.equal(requested, 'https://api.github.com/repos/YouEye-Platform/Market/commits/main');
});

test('Market source rejects nested or ambiguous refs', () => {
  for (const branch of ['../main', 'main//next', 'main/']) {
    assert.throws(() => parseMarketRepoURL(DEFAULT_MARKET_REPO_URL, { branch }), /safe branch name/);
  }
});

test('signed Market app releases require a same-origin release-scoped browser URL', () => {
  const source = parseMarketRepoURL('https://forgejo.example.test/potemsla/YE-AppMarket');
  const valid = 'https://forgejo.example.test/potemsla/Wiki/releases/download/dev-v0.5.0/standalone.tar';
  assert.equal(getMarketReleaseAssetDownloadURL(source, {
    name: 'standalone.tar',
    uuid: 'opaque-forgejo-id',
    browser_download_url: valid,
  }), valid);

  for (const browser_download_url of [
    'https://evil.example/potemsla/Wiki/releases/download/dev-v0.5.0/standalone.tar',
    'https://forgejo.example.test/attachments/opaque-forgejo-id',
    'https://forgejo.example.test/potemsla/Wiki/releases/download/dev-v0.5.0/other.tar',
    'https://forgejo.example.test/potemsla/Wiki/releases/download/dev-v0.5.0%2fescape/standalone.tar',
  ]) {
    assert.equal(getMarketReleaseAssetDownloadURL(source, {
      name: 'standalone.tar',
      uuid: 'opaque-forgejo-id',
      browser_download_url,
    }), null);
  }
  assert.equal(getMarketReleaseAssetDownloadURL(source, {
    name: 'standalone.tar',
    uuid: 'opaque-forgejo-id',
  }), null);
});

test('hosted Market URLs preserve immutable identity and leave custom Git sources alone', async () => {
  const { hostedMarketRawURL } = await import('../src/lib/market/source');
  const source = parseMarketRepoURL(DEFAULT_MARKET_REPO_URL);
  const commit = 'a'.repeat(40);
  const policy = { schema: 'youeye.distribution-policy.v1', origin: 'https://releases.youeye.me', keys: {stable:'test-key'} };
  assert.equal(hostedMarketRawURL(source,'YouEye-Platform','Market','apps/example/icon.svg',commit,policy),`https://catalog.youeye.me/v1/snapshots/${commit}/apps/example/icon.svg`);
  for (const other of [{...source,trust:'custom' as const},{...source,base_url:'https://forge.example.test'},{...source,organization:'someone-else'}]) assert.equal(hostedMarketRawURL(other,'YouEye-Platform','Market','catalog.yaml',commit,policy),null);
  assert.equal(hostedMarketRawURL(source,'YouEye-Platform','Pointer','youeye-app.yaml',commit,policy),null);
  assert.equal(hostedMarketRawURL(source,'YouEye-Platform','Market','catalog.yaml','main',policy),null);
  assert.equal(hostedMarketRawURL(source,'YouEye-Platform','Market','catalog.yaml',commit,{...policy,origin:''}),null);
  assert.throws(()=>hostedMarketRawURL(source,'YouEye-Platform','Market','apps/../secret',commit,policy));
});


test('catalog refs stay scoped to their repository, including explicit native app pins', async () => {
  const { catalogEntryRef } = await import('../src/lib/market/source');
  const { CatalogEntrySchema, IntegrationCatalogEntrySchema } = await import('../src/lib/market/schema');
  const catalogCommit = 'a'.repeat(40), appCommit = 'b'.repeat(40);
  for (const schema of [CatalogEntrySchema, IntegrationCatalogEntrySchema]) {
    const entry = schema.parse({ id: 'example', repo: 'example/App', branch: 'stable' });
    assert.equal(entry.branch, 'stable');
    assert.equal(catalogEntryRef(entry, catalogCommit, {branch:'beta'}), 'stable');
    assert.equal(catalogEntryRef({...entry,branch:appCommit}, catalogCommit, {branch:'main'}), appCommit);
    assert.equal(catalogEntryRef({...entry,branch:undefined}, catalogCommit, {branch:'beta'}), 'beta');
    assert.equal(catalogEntryRef({...entry,branch:undefined}, catalogCommit, {branch:catalogCommit}), 'main');
    for (const branch of ['../main', 'main//next', 'main/', 'main?token=x']) {
      assert.equal(schema.safeParse({id:'example',repo:'example/App',branch}).success, false);
    }
  }
  assert.equal(catalogEntryRef({branch:'main'},catalogCommit,{branch:'main'}),catalogCommit);
});


test('only matching official legacy native manifests map to their published repository', async () => {
  const { publicNativeManifestRepo } = await import('../src/lib/market/source');
  const official = parseMarketRepoURL(DEFAULT_MARKET_REPO_URL);
  assert.equal(publicNativeManifestRepo(official,'YouEye-Platform/Search','potemsla/YE-App-Search'),'YouEye-Platform/Search');
  for (const source of [{...official,trust:'custom' as const},parseMarketRepoURL('https://forge.example.test/potemsla/YE-AppMarket'),{...official,organization:'someone-else'}]) {
    assert.equal(publicNativeManifestRepo(source,'YouEye-Platform/Search','potemsla/YE-App-Search'),'potemsla/YE-App-Search');
  }
  for (const repo of ['other/YE-App-Search','potemsla/YE-App-Search-Fork','https://forge.example.test/potemsla/YE-App-Search','YouEye-Platform/Search']) {
    assert.equal(publicNativeManifestRepo(official,'YouEye-Platform/Search',repo),repo);
  }
  assert.equal(publicNativeManifestRepo(official,'YouEye-Platform/Wiki','potemsla/YE-App-Search'),'potemsla/YE-App-Search');
});
