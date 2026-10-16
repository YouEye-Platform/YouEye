import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import publicPolicy from '../../spine/internal/systemupdate/public-release-trust.json';
import { acceptCatalogRelease, catalogDependencySource, readAcceptedCatalog, verifyCatalogFile } from '../src/lib/market/catalog-release';
import { buildMarketRawURL, parseMarketRepoURL, publicNativeManifestRepo } from '../src/lib/market/source';
import { catalogRepoReferenceToUrl } from '../src/lib/market/update-routing';
import { verifyProductRelease, type ProductBuild, type ProductRelease } from '../src/lib/releases/product-release';
import { selectInfrastructureStandaloneRelease } from '../src/lib/infrastructure/release-resolver';

const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
test('Market accepts signed labels over the same catalog and retains offline bytes and replay floor', async () => {
  const key = generateKeyPairSync('ed25519'), previous = publicPolicy.keys;
  publicPolicy.keys = {...previous,stable:key.publicKey.export({type:'spki',format:'pem'}).toString()};
  const directory = await mkdtemp(join(tmpdir(),'youeye-market-release-'));
  try {
    const source = parseMarketRepoURL('https://github.com/YouEye-Platform/Market');
    const catalog = 'apps: []\n', file = 'id: example\n';
    const snapshot = Buffer.from(JSON.stringify({apiVersion:'youeye.market/catalog-snapshot/v1',catalog:{sha256:`sha256:${sha(catalog)}`},content:{files:[{path:'catalog.yaml',sha256:`sha256:${sha(catalog)}`},{path:'apps/example.yaml',sha256:`sha256:${sha(file)}`}]}}));
    const signer = sha(key.publicKey.export({type:'spki',format:'der'}));
    const build: ProductBuild = {schema:'youeye.product-build.v1',product:'market',kind:'catalog',build_version:'1.2.3',source:source.repo_url,branch:'main',source_commit:'a'.repeat(40),tag:'catalog-v1.2.3',input_sha256:'b'.repeat(64),contract_sha256:sha(snapshot),signer_sha256:signer,primary:'catalog-snapshot.json',assets:[{name:'catalog-snapshot.json',url:`${source.repo_url}/releases/download/catalog-v1.2.3/catalog-snapshot.json`,sha256:sha(snapshot),size_bytes:snapshot.length}]};
    const buildRaw = Buffer.from(JSON.stringify(build));
    const release = (version: string, sequence: number) => {
      const r: ProductRelease = {schema:'youeye.product-release.v1',product:'market',version,source:source.repo_url,branch:'main',tag:`catalog-v${version}`,channel:'stable',sequence,minimum_reader:1,signer_sha256:signer,build_manifest_base64:buildRaw.toString('base64'),build_signature_base64:sign(null,buildRaw,key.privateKey).toString('base64')};
      const raw = Buffer.from(JSON.stringify(r));
      return verifyProductRelease(raw,sign(null,raw,key.privateKey),{product:'market',source:source.repo_url,tag:r.tag});
    };
    assert.equal(await readAcceptedCatalog(source,directory),null);
    await acceptCatalogRelease(source,release('1.2.3',3),snapshot,catalog,directory);
    await acceptCatalogRelease(source,release('1.2.4',4),snapshot,catalog,directory);
    const accepted = (await readAcceptedCatalog(source,directory))!;
    assert.equal(accepted.catalog,catalog);
    assert.equal(accepted.selected.release.version,'1.2.4');
    assert.equal(accepted.selected.build.build_version,'1.2.3');
    assert.equal(accepted.selected.build.source_commit,build.source_commit);
    // A release mirror cannot reinterpret the original catalog's relative
    // dependency repositories as repositories hosted on that mirror.
    const mirror = parseMarketRepoURL('https://forge.example.test/team/Market', {id:'alpha-market'});
    const dependencies = catalogDependencySource(mirror, accepted);
    assert.equal(dependencies.repo_url,source.repo_url);
    assert.equal(dependencies.id,mirror.id);
    assert.equal(buildMarketRawURL(dependencies,'YouEye-Platform','Notes','youeye-app.yaml','main'),
      'https://raw.githubusercontent.com/YouEye-Platform/Notes/main/youeye-app.yaml');
    assert.equal(publicNativeManifestRepo(dependencies,'YouEye-Platform/Notes','potemsla/YE-App-Notes'),'YouEye-Platform/Notes');
    const appRepo = `${dependencies.base_url}/YouEye-Platform/Notes`;
    assert.equal(catalogRepoReferenceToUrl(appRepo,mirror.repo_url),appRepo);
    assert.equal(catalogDependencySource(mirror,null),mirror,'legacy/private catalogs keep their selected host');
    assert.equal(catalogDependencySource(source,accepted),source);
    verifyCatalogFile(accepted.snapshot,'apps/example.yaml',file);
    assert.throws(()=>verifyCatalogFile(accepted.snapshot,'apps/example.yaml','changed'),/differs/);
    await assert.rejects(acceptCatalogRelease(source,release('1.2.3',3),snapshot,catalog,directory),/rollback/);
    await assert.rejects(acceptCatalogRelease(source,release('1.2.5',4),snapshot,catalog,directory),/substitution/);
    await assert.rejects(acceptCatalogRelease(source,release('1.2.5',5),snapshot,catalog+'changed',directory),/differs/);
    await assert.rejects(acceptCatalogRelease(source,release('1.2.5',5),Buffer.from('{}'),catalog,directory),/differs/);
    assert.equal((await readAcceptedCatalog(source,directory))?.selected.release.version,'1.2.4');
    assert.equal(await readAcceptedCatalog({...source,branch:'beta'},directory),null);
    // Offline operation still rechecks the currently trusted key.
    publicPolicy.keys = previous;
    await assert.rejects(readAcceptedCatalog(source,directory),/trust is not provisioned|signature/);
  } finally { publicPolicy.keys = previous; await rm(directory,{recursive:true,force:true}); }
});

test('catalog discovery selects private Alpha labels and excludes drafts and public Alpha', () => {
  const source = parseMarketRepoURL('https://forge.example.test/team/Market');
  const releases = ['1.2.3-alpha.1','1.2.3-alpha.2'].map(version=>({tag_name:`catalog-v${version}`,draft:version.endsWith('.2'),assets:[{name:'product-release.json',browser_download_url:`${source.repo_url}/releases/download/catalog-v${version}/product-release.json`}]}));
  assert.equal(selectInfrastructureStandaloneRelease(source,releases,'catalog','main')?.version,'1.2.3-alpha.1');
  const publicSource = parseMarketRepoURL('https://github.com/YouEye-Platform/Market');
  assert.equal(selectInfrastructureStandaloneRelease(publicSource,releases,'catalog','main'),null);
});
