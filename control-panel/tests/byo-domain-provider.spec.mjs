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
  assert.match(source, /validateDnsProvider\(\{ provider, domain, token, writeTest: true \}\)/);
  assert.match(source, /writeProviderToken\(connectionId, token\)/);
  assert.match(source, /syncByoDomainDns\('setup', hostIP\)/);
  assert.match(source, /issueCertificateWithDnsProvider/);
  assert.doesNotMatch(source, /tls_choice === 'byo-provider'[\s\S]*console\.log\([^)]*token/);
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
  assert.match(source, /Renew now/);
  assert.doesNotMatch(source, /value=\{connection\.[^}]*token/);
});
