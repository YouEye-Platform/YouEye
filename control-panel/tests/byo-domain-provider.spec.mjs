import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('domain helper keeps platform domain exact and manages only its wildcard', () => {
  const source = read('src/lib/dns-providers/domain.ts');

  assert.match(source, /export function managedAddressNames\(domain: string\): string\[\]/);
  assert.match(source, /return \[domain, `\*\.\$\{domain\}`\]/);
  assert.match(source, /export function candidateZonesForDomain\(domain: string\): string\[\]/);
  assert.doesNotMatch(source, /slice\(-2\)/);
});

test('Cloudflare validation detects delegated platform names before saving', () => {
  const source = read('src/lib/dns-providers/cloudflare.ts');
  const validation = read('src/lib/dns-providers/validation.ts');

  assert.match(source, /detectDelegation/);
  assert.match(source, /listRecords\(input\.zone, input\.domain, 'NS'\)/);
  assert.match(source, /hasPublicNsAtName\(input\.domain\)/);
  assert.match(validation, /is delegated to another DNS zone/);
  assert.match(validation, /_youeye-validate-/);
});

test('setup provider path validates, stores token as a secret, syncs DNS, and issues cert', () => {
  const source = read('src/app/api/setup/run/route.ts');

  assert.match(source, /body\.tls_choice === 'byo-provider'/);
  assert.match(source, /getStagedByoDomainBundle\(\)/);
  assert.match(source, /byoDomainBundleCertStillValid\(staged\)/);
  assert.match(source, /validateDnsProvider\(\{ provider, domain, token, writeTest: true \}\)/);
  assert.match(source, /writeProviderToken\(connectionId, token\)/);
  assert.match(source, /syncByoDomainDns\('setup', hostIP\)/);
  assert.match(source, /issueCertificateWithDnsProvider/);
  assert.match(source, /consumeStagedByoDomainBundle\(\)/);
  assert.doesNotMatch(source, /tls_choice === 'byo-provider'[\s\S]*console\.log\([^)]*token/);
});

test('provider config is persisted using Spine-compatible string extras', () => {
  const config = read('src/lib/dns-providers/config.ts');
  const sync = read('src/lib/dns-providers/sync.ts');

  assert.match(config, /settingsService\.setRaw\(\{ \[CONFIG_KEY\]: JSON\.stringify\(config\) \}\)/);
  assert.match(config, /const saved = await getByoDnsProviderConfig\(\)/);
  assert.match(config, /DNS provider config could not be saved/);
  assert.match(config, /settingsService\.setRaw\(\{ \[CONFIG_KEY\]: '' \}\)/);
  assert.match(sync, /reason === 'setup' \|\| reason === 'connect'/);
  assert.match(sync, /DNS provider config is not available/);
  assert.doesNotMatch(config, /settingsService\.setRaw\(\{ \[CONFIG_KEY\]: config \}\)/);
  assert.doesNotMatch(config, /settingsService\.setRaw\(\{ \[CONFIG_KEY\]: null \}\)/);
});

test('BYO domain bundle export excludes DNS token unless explicitly requested', () => {
  const bundle = read('src/lib/byo-domain/bundle.ts');
  const exportRoute = read('src/app/api/tls/domain/export/route.ts');
  const reuseRoute = read('src/app/api/tls/domain/reuse/route.ts');
  const spineClient = read('src/lib/spine/client.ts');

  assert.match(bundle, /BYO_DOMAIN_BUNDLE_TYPE = 'youeye-byo-domain'/);
  assert.match(bundle, /dnsToken: includeToken && token \? \{ included: true, value: token \} : \{ included: false \}/);
  assert.match(bundle, /readProviderToken\(config\.connectionId\)/);
  assert.match(bundle, /safeByoDomainBundleSummary/);
  assert.match(exportRoute, /includeToken/);
  assert.match(exportRoute, /cache-control': 'no-store'/);
  assert.match(reuseRoute, /safeByoDomainBundleSummary\(bundle\)/);
  assert.match(spineClient, /return \{ \.\.\.rest, \.\.\.extra as Record<string, unknown>, extra \}/);
  assert.doesNotMatch(reuseRoute, /dnsToken\.value/);
});

test('host IP migration syncs configured external DNS provider', () => {
  const source = read('src/app/api/host-ip/migrate/route.ts');

  assert.match(source, /import \{ syncByoDomainDns \}/);
  assert.match(source, /syncByoDomainDns\('host-ip-change', newIP\)/);
  assert.match(source, /providerDns/);
});

test('provider-managed domains cannot use the shallow domain setter', () => {
  const source = read('src/app/api/domain/route.ts');

  assert.match(source, /getByoDnsProviderConfig/);
  assert.match(source, /providerConfig\?\.mode === 'byo-provider'/);
  assert.match(source, /Use the full reconfigure flow/);
});

test('settings network page exposes provider controls without returning token material', () => {
  const source = read('src/components/settings-shell/network-client.tsx');

  assert.match(source, /DNS provider/);
  assert.match(source, /Connect and secure domain/);
  assert.match(source, /Sync DNS now/);
  assert.match(source, /Replace token/);
  assert.match(source, /Export bundle/);
  assert.match(source, /With token/);
  assert.match(source, /Renew now/);
  assert.doesNotMatch(source, /value=\{connection\.[^}]*token/);
});

test('setup screen recognizes staged BYO domain bundles without exposing token material', () => {
  const source = read('src/components/setup/SetupServerName.tsx');

  assert.match(source, /\/api\/tls\/domain\/reuse/);
  assert.match(source, /Domain bundle staged/);
  assert.match(source, /usingStagedDomainToken/);
  assert.match(source, /setProviderValid\(\!\!d\.hasDnsToken\)/);
  assert.doesNotMatch(source, /domainReuse[^]*dnsToken\.value/);
});

test('setup BYO provider validation and manual certificate path handle first-run routing', () => {
  const source = read('src/components/setup/SetupServerName.tsx');

  assert.match(source, /readSetupJson\(csrfRes, 'Could not read setup session'\)/);
  assert.match(source, /readSetupJson\(res, 'Cloudflare connection failed'\)/);
  assert.match(source, /Setup session expired\. Refresh setup and sign in again\./);
  assert.match(source, /response\.redirected/);
  assert.match(source, /response\.url\.includes\('\/login'\)/);
  assert.match(source, /manualLetsEncryptIsLocal/);
  assert.match(source, /tlsChoice === 'byo-provider'[\s\S]*isLocalHostname\(providerDomain\)/);
  assert.match(source, /carryProviderDomainToManualCertificate/);
  assert.match(source, /setDomainSlug\(slug\)/);
  assert.match(source, /setCustomTld\(providerDomain\.slice\(lastDot \+ 1\)\)/);
});
