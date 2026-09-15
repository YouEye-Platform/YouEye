import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const controlPanelRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const youEyeRoot = join(controlPanelRoot, '..');
const repoRoot = join(youEyeRoot, '..');

// The app-market is a SEPARATE repo (forgejo.example.test/potemsla/YE-AppMarket; GitHub
// name "Market"). It sits beside the YouEye monorepo when checked out. Resolve it
// robustly across both names + an env override, and skip catalog assertions when
// it isn't present (it isn't part of control-panel).
function resolveMarketRoot(): string | null {
  const candidates = [
    process.env.MARKET_ROOT,
    join(repoRoot, 'YE-AppMarket'),
    join(repoRoot, 'Market'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, 'catalog.yaml'))) ?? null;
}

function read(relativePath: string): string {
  return readFileSync(join(controlPanelRoot, relativePath), 'utf8');
}

test('fresh infrastructure deploy does not install or reconcile Authentik', () => {
  const deployer = read('src/lib/infrastructure/deployer.ts');

  assert.doesNotMatch(deployer, /authentikServerManifest|authentikWorkerManifest/);
  assert.doesNotMatch(deployer, /setupAuthentikDatabase|createAuthentikAPIToken|setupCaddyAuthentikRoute/);
  assert.doesNotMatch(deployer, /youeye-authentik/);
  assert.match(deployer, /const TOTAL_STEPS = 5;/);
  assert.match(deployer, /Deploying YouEye AI service/);
  // Security posture is now a real first reconcile step, followed by the five
  // infrastructure containers. Neither count includes retired Authentik work.
  assert.match(deployer, /const RECONCILE_STEPS = 6;/);
});

test('setup flow configures YouEye ID routes while owner claim creates the user', () => {
  const setup = read('src/app/api/setup/run/route.ts');
  const claim = read('src/app/api/appliance/claim/route.ts');

  assert.doesNotMatch(setup, /container: 'youeye-authentik'|subs\.auth/);
  assert.doesNotMatch(setup, /getAuthentikConfig|authentikAPI|youeye-authentik/);
  assert.doesNotMatch(setup, /ensureIdentityAdminUser|admin_password/);
  assert.match(claim, /claimApplianceOwner/);
  assert.match(setup, /ensureIdentityRoute/);
});

test('system app catalog no longer advertises Authentik', (t) => {
  const marketRoot = resolveMarketRoot();
  if (!marketRoot) {
    t.skip('YE-AppMarket repo not checked out beside YouEye (set MARKET_ROOT) — catalog assertion needs the separate market repo');
    return;
  }
  const catalog = readFileSync(join(marketRoot, 'catalog.yaml'), 'utf8');

  assert.doesNotMatch(catalog, /id:\s+authentik/);
  assert.equal(existsSync(join(marketRoot, 'system', 'authentik.yaml')), false);
});

test('retired Authentik runtime implementation and endpoints are absent', () => {
  const removed = [
    'src/lib/authentik/client.ts',
    'src/lib/market/authentik.ts',
    'src/lib/smtp/authentik-sync.ts',
    'src/lib/auth/sso-setup.ts',
    'src/app/api/apps/identity/groups/route.ts',
    'src/app/api/apps/identity/stats/route.ts',
    'src/app/api/auth/sso/setup/route.ts',
    'src/app/api/auth/sso/status/route.ts',
    'src/app/api/auth/sso/disable/route.ts',
  ];
  for (const path of removed) {
    assert.equal(existsSync(join(controlPanelRoot, path)), false, `${path} must stay retired`);
  }

  const provider = read('src/lib/identity/provider.ts');
  const variables = read('src/lib/market/platform-env.ts');
  const variableTypes = read('src/lib/market/types.ts');
  const spine = readFileSync(join(youEyeRoot, 'spine/internal/api/server.go'), 'utf8');

  assert.doesNotMatch(provider, /['"]authentik['"]/i);
  assert.doesNotMatch(variables, /authentik/i);
  assert.doesNotMatch(variableTypes, /authentik/i);
  assert.doesNotMatch(spine, /\/api\/authentik\/credentials|youeye-authentik/i);
});

test('generic OAuth helpers are named for their protocol and app subdomains update YouEye ID', () => {
  const controlOAuth = 'src/lib/auth/oauth.ts';
  const uiOAuth = join(youEyeRoot, 'ui/src/lib/auth/oauth.ts');
  assert.equal(existsSync(join(controlPanelRoot, controlOAuth)), true);
  assert.equal(existsSync(uiOAuth), true);
  assert.equal(existsSync(join(controlPanelRoot, 'src/lib/auth/authentik.ts')), false);
  assert.equal(existsSync(join(youEyeRoot, 'ui/src/lib/auth/authentik.ts')), false);

  const subdomain = read('src/app/api/ui-bridge/apps/subdomain/route.ts');
  assert.match(subdomain, /getClient\(ssoClientId\)/);
  assert.match(subdomain, /clientSecret: client\.client_secret/);
  assert.match(subdomain, /redirectUris: client\.redirect_uris/);
  assert.doesNotMatch(subdomain, /authentik/i);
});

test('the one historical identity-column migration remains readable', () => {
  const uiDatabase = readFileSync(join(youEyeRoot, 'ui/src/db/index.ts'), 'utf8');
  assert.match(uiDatabase, /RENAME COLUMN authentik_id TO identity_id/);
});
