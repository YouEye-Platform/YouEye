import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixtureManifest } from './fixtures/app-update-appliance';
import { parseManifest } from '../src/lib/market/parser';
import { resolveManifestPaths } from '../src/lib/market/catalog';
import { verifyMarketProductInstallContract } from '../src/lib/market/native-artifact';
import { parseMarketRepoURL } from '../src/lib/market/source';
import type { InstallConfig } from '../src/lib/market/types';
import type { VerifiedProductRelease } from '../src/lib/releases/product-release';

test('signed native contract permits exact public catalog projection but refuses changed installer semantics', async () => {
  const raw = fixtureManifest('shared', '1.0.0');
  raw.metadata.id = 'notes';
  raw.metadata.iconUrl = 'assets/icon.svg';
  raw.detail = {longDescription:'Example application',screenshots:[{path:'assets/screen.png',caption:'Example'}]};
  raw.integration = 'native';
  raw.containers[0] = {...raw.containers[0],type:'lxd',source:{repo:'potemsla/YE-App-Notes'}};
  const contract = Buffer.from(JSON.stringify(raw));
  // The caller has already verified both signatures. Exercise the real parser
  // and catalog transforms at the installer boundary, not a hand-built clone.
  const selected = {build:{build_version:'1.0.0',contract_sha256:createHash('sha256').update(contract).digest('hex')},
    release:{product:'notes',version:'1.0.1'}} as VerifiedProductRelease;
  const original = parseManifest(contract.toString());
  const config: InstallConfig = {appId:'notes',subdomain:'notes',domain:'example.test',
    manifestRepo:'YouEye-Platform/Notes',manifestPath:'youeye-app.yaml',manifestBranch:'v1.0.1'};
  const source = parseMarketRepoURL('https://github.com/YouEye-Platform/Market');
  const projected = structuredClone(original);
  projected.containers[0].source!.repo = 'YouEye-Platform/Notes';
  projected.version = '1.0.1';
  await resolveManifestPaths(projected,'YouEye-Platform','Notes','v1.0.1',source);
  assert.notDeepEqual(projected.detail,original.detail);
  await verifyMarketProductInstallContract(contract,selected,projected,config,source);
  await verifyMarketProductInstallContract(contract,selected,original,{...config,sourceId:'direct:example'},source);
  for (const mutate of [
    (m: typeof projected) => { m.containers[0].image = 'foreign/image'; },
    (m: typeof projected) => { m.containers[0].source!.repo = 'foreign/Notes'; },
    (m: typeof projected) => { m.database!.name = 'foreign_database'; },
    (m: typeof projected) => { m.detail!.screenshots![0].path = 'https://foreign.example/screen.png'; },
  ]) {
    const changed = structuredClone(projected); mutate(changed);
    await assert.rejects(verifyMarketProductInstallContract(contract,selected,changed,config,source),/differs/);
  }
  await assert.rejects(verifyMarketProductInstallContract(Buffer.concat([contract,Buffer.from(' ')]),selected,projected,config,source),/digest differs/);
  await assert.rejects(verifyMarketProductInstallContract(contract,selected,projected,{...config,sourceId:'direct:example'},source),/differs/);
  await assert.rejects(verifyMarketProductInstallContract(contract,selected,projected,config,{...source,trust:'custom'}),/differs/);
});
