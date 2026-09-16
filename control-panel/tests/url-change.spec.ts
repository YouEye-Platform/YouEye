import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for the server URL change mechanic (0407-urlchange).
// Run: pnpm exec node --import tsx --test tests/url-change.spec.ts
//
// Live coverage happens on a dev appliance (devvm.test → urlchange.test →
// names-bundle round trip); these specs pin the engine's propagation contract
// so it cannot silently regress to the pre-0.5.6 behavior that left native app
// env files and Nextcloud trusted_domains on the old domain.

const controlPanelRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const repoRoot = join(controlPanelRoot, '..');

function read(relativePath: string): string {
  return readFileSync(join(controlPanelRoot, relativePath), 'utf8');
}

const engine = read('src/lib/reconfigure/index.ts');

test('reconfigure engine propagates env by exact string replacement (both container models)', () => {
  // LXD/native apps: /etc/<container>.env rewrite
  assert.match(engine, /updateContainerEnvFile/);
  assert.match(engine, /\/etc\/\$\{containerName\}\.env/);
  // OCI/market apps: Incus environment.* config rewrite
  assert.match(engine, /updateContainerEnvConfig/);
  assert.match(engine, /key\.startsWith\('environment\.'\)/);
  // Exact replacement, never regex/secret-rotating re-resolution
  assert.match(engine, /function replaceAll\(/);
  // The dead pre-0.5.6 path resolved `${install.*}` templates from
  // manifest.containers[].environment and missed env files entirely.
  assert.doesNotMatch(engine, /template\.includes\('\$\{install\./);
});

test('reconfigure engine refreshes manifest config files (replace existing, render missing)', () => {
  assert.match(engine, /refreshConfigFiles/);
  assert.match(engine, /writeConfigFileToStorage\(/);
  assert.match(engine, /readConfigFile\(target\.containerName, cf, ctx, volumes\)/);
  assert.match(engine, /target\.type === 'oci'/);
  assert.match(engine, /meta\.storageVolumes/);
  assert.match(engine, /fetchManifestFromSource/);
});

test('reconfigure engine applies an explicit TLS target for the new name', () => {
  assert.match(engine, /applyTlsTarget/);
  // Self-signed: external cert is removed so the internal CA re-issues.
  assert.match(engine, /removeExternalCert/);
  assert.match(engine, /revertToInternal/);
  // Names bundle: cert loaded + lease resumed + broker DNS repointed.
  assert.match(engine, /claimName\(bundle\.name/);
  assert.match(engine, /updateIp\(bundle\.name/);
  // Subdomain-only changes must NOT drop an existing external cert.
  assert.match(engine, /stored\.mode === 'acme' \|\| stored\.mode === 'manual'/);
  // A same-domain credential repair must still reinstall bundle authority.
  assert.match(engine, /!domainChanged[\s\S]*!subdomainsChanged[\s\S]*tlsTarget === 'names-bundle'[\s\S]*applyTlsTarget\(tlsTarget/);
});

test('reconfigure engine restarts YouEye ID and defers the CP restart to last', () => {
  assert.match(engine, /'youeye-id'/);
  const identityIdx = engine.indexOf("step: 'identity', status: 'running'");
  const cpEnvIdx = engine.indexOf("step: 'cp_env', status: 'running'");
  assert.ok(identityIdx > 0 && cpEnvIdx > identityIdx, 'youeye-id restart must precede the final cp_env step');
});

test('reconfigure refreshes Pointer issuer and routing after persisting the new domain', () => {
  const yamlIdx = engine.indexOf("step: 'yaml', status: 'done'");
  const pointerIdx = engine.indexOf('await configurePointerForPlatform()');
  assert.ok(yamlIdx > 0 && pointerIdx > yamlIdx, 'Pointer must read the newly persisted platform identity');
  assert.match(engine, /ensurePointerInferenceRoutes\(newDomain\)/);
});

test('reconfigure engine honors intentionally-stopped apps', () => {
  assert.match(engine, /desiredState === 'stopped'/);
  assert.match(engine, /restartContainerAndWait/);
  const restartIdx = engine.indexOf('await restartContainerAndWait');
  const enforceIdx = engine.indexOf('await enforceConfigFilePermissions', restartIdx);
  assert.ok(restartIdx > 0 && enforceIdx > restartIdx, 'OCI permissions must be reasserted after restart');
});

test('reconfigure route sanitizes wire input — bundle targets are programmatic only', () => {
  const route = read('src/app/api/setup/reconfigure/route.ts');
  assert.match(route, /WIRE_TLS_TARGETS/);
  assert.doesNotMatch(route, /raw\.namesBundle|raw\.byoBundle/);
});

test('post-setup apply endpoints exist for names and domain bundles', () => {
  const namesApply = read('src/app/api/tls/youeye-names/apply/route.ts');
  assert.match(namesApply, /applyBundleIdentity/);
  assert.match(namesApply, /parseNamesBundle/);
  assert.match(namesApply, /validateCertificateMaterial/);
  assert.match(namesApply, /tls: 'names-bundle'/);

  const domainApply = read('src/app/api/tls/domain/apply/route.ts');
  assert.match(domainApply, /isByoDomainBundle/);
  assert.match(domainApply, /tls: 'byo-bundle'/);
  // Expired cert without a token must fail loudly up front.
  assert.match(domainApply, /dnsToken\.included/);
});

test('Settings network panel drives the FULL reconfigure, not the shallow /api/domain', () => {
  const panel = read('src/components/settings-shell/network-client.tsx');
  assert.match(panel, /\/api\/setup\/reconfigure/);
  assert.doesNotMatch(panel, /fetch\("\/api\/domain",\s*\{\s*method:\s*"POST"/);
  // Bundle import routes to the live apply endpoints.
  assert.match(panel, /\/api\/tls\/youeye-names\/apply/);
  assert.match(panel, /\/api\/tls\/domain\/apply/);
  // The flow warns before acting and streams step progress.
  assert.match(panel, /Everyone is signed out/);
  assert.match(panel, /stepLabel/);
});

test('Spine CLI: domain set runs the full reconfigure post-setup; imports switch live', () => {
  const spineCmd = join(repoRoot, 'spine', 'internal', 'cmd');
  const domainGo = readFileSync(join(spineCmd, 'domain.go'), 'utf8');
  const namesGo = readFileSync(join(spineCmd, 'names.go'), 'utf8');
  const urlchangeGo = readFileSync(join(spineCmd, 'urlchange.go'), 'utf8');

  assert.match(domainGo, /streamURLChange\("\/api\/setup\/reconfigure"/);
  assert.match(domainGo, /streamURLChange\("\/api\/tls\/domain\/apply"/);
  assert.match(namesGo, /streamURLChange\("\/api\/tls\/youeye-names\/apply"/);
  // Pre-setup staging behavior is preserved for both bundles.
  assert.match(domainGo, /Staged BYO domain bundle/);
  assert.match(namesGo, /Staged YouEye Names recovery bundle/);
  // Confirmation guard with --yes bypass.
  assert.match(urlchangeGo, /confirmURLChange/);
  assert.match(domainGo, /"yes", "y"/);
});

test('Nextcloud manifest keeps trusted_domains on the platform domain through supported reconfigure commands', () => {
  // The Market repo is a sibling clone on dev machines; tolerate either name.
  const candidates = [join(repoRoot, '..', 'YE-AppMarket'), join(repoRoot, '..', 'Market')];
  const marketRoot = candidates.find((p) => existsSync(join(p, 'apps', 'nextcloud', 'youeye-app.yaml')));
  if (!marketRoot) {
    // Not cloned next to the monorepo — covered by live appliance testing.
    return;
  }
  const manifest = readFileSync(join(marketRoot, 'apps', 'nextcloud', 'youeye-app.yaml'), 'utf8');
  assert.match(manifest, /^\s*OVERWRITEHOST:\s*["']\$\{app\.fqdn\}["']\s*$/m);
  assert.match(manifest, /config:system:set trusted_domains 1 --value=.*\$OVERWRITEHOST/);
  assert.match(manifest, /config:system:set overwritehost --value=.*\$OVERWRITEHOST/);
  assert.match(manifest, /config:system:set overwrite\.cli\.url --value=.*\$OVERWRITEHOST/);
  assert.doesNotMatch(manifest, /zz-youeye\.config\.php/);
});
