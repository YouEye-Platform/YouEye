import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { allowedPointerManagementPath } from '../src/lib/pointer/management-path';
import { allowedPointerAssetPath } from '../src/lib/pointer/ui-assets';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (filename: string) => readFileSync(path.join(root, filename), 'utf8');

test('personal Pointer management paths reject traversal, private lifecycle and inference', () => {
  for (const path of ['/api/providers', '/api/connections/codex/accounts', '/api/groups/fixture', '/api/sources/settings', '/api/admin/settings']) assert.equal(allowedPointerManagementPath(path), true);
  for (const path of ['/v1/models', '/api/platform/v1/installations', '/api/auth/login', '//evil.test/api/providers', '/api/providers/../platform', '/api/providers/%2e%2e/keys', '/api/providersx']) assert.equal(allowedPointerManagementPath(path), false);
});

test('public assets cannot read engine or account files', () => {
  for (const path of ['manifest.json', 'entry-0123456789abcdef.js', 'fonts/0123456789abcdef-plex-sans.woff2']) assert.equal(allowedPointerAssetPath(path), true);
  for (const path of ['../server.env', '/api/connections', 'manifest.json?token=secret', 'fonts/%2e%2e/account.json']) assert.equal(allowedPointerAssetPath(path), false);
});

test('bundled AI SVG brands have a clean-checkout TypeScript module contract', () => {
  const declaration = read('src/types/svg.d.ts');
  assert.match(declaration, /declare module '\*\.svg'/);
  assert.match(declaration, /src: string/);
  assert.match(declaration, /width: number/);
  assert.match(declaration, /height: number/);
});

test('same-origin AI adapter authenticates users server-side and rejects route or CSRF expansion', () => {
  const route = read('src/app/api/ai/[...path]/route.ts');
  const pointer = read('src/lib/pointer/client.ts');
  const tokens = read('src/lib/identity/tokens.ts');
  assert.match(route, /getSession/);
  assert.match(route, /verifyCSRFToken/);
  assert.match(route, /allowedPointerManagementPath/);
  assert.match(route, /pointerManagementFetch/);
  assert.match(route, /upstream\.body/);
  assert.doesNotMatch(route, /upstream\.arrayBuffer/);
  assert.doesNotMatch(route, /request\.headers\.get\(['"]authorization/);
  assert.match(pointer, /authorization: `Bearer \$\{assertion\}`/);
  assert.match(read('src/lib/pointer/management-path.ts'), /new URL\(path, 'http:\/\/pointer\.internal'\)\.pathname/);
  assert.match(pointer, /AI settings require a YouEye user account/);
  assert.match(tokens, /pointer_owner_scope: 'actor'/);
  assert.match(tokens, /sub: user\.id/);
  assert.match(tokens, /setExpirationTime\('2m'\)/);
  assert.match(tokens, /setJti\(randomUUID\(\)\)/);
});

test('Pointer is a managed core service with isolated listeners, database, secrets, update migration, and backup', () => {
  const lifecycle = read('src/lib/pointer/lifecycle.ts');
  const manifests = read('src/lib/infrastructure/manifests.ts');
  const lxdDeployer = read('src/lib/infrastructure/lxd-deployer.ts');
  const definitions = read('src/lib/apps/definitions.ts');
  const backup = read('src/lib/backup/core-backup.ts');
  const postgres = read('src/lib/backup/postgres.ts');
  const staticIps = read('src/lib/incus/static-ips.ts');
  const security = read('src/lib/infrastructure/security-posture.ts');
  const appNetwork = read('src/lib/incus/app-network.ts');
  const spineStaticIps = read('../spine/internal/incus/static_ips.go');
  assert.match(manifests, /containerName: 'youeye-pointer'/);
  assert.match(manifests, /runtime: 'bun'/);
  assert.match(lifecycle, /const POINTER_DATABASE = 'pointer'/);
  assert.match(lifecycle, /MANAGEMENT_PORT=4001/);
  assert.match(lifecycle, /INFERENCE_PORT=4002/);
  assert.match(lifecycle, /PLATFORM_SIGNING_ALGORITHMS=RS256/);
  assert.match(lifecycle, /identity\.externalUrl\}\/oauth\/jwks/);
  assert.doesNotMatch(lifecycle, /application\/o\/jwks/);
  assert.match(lifecycle, /MANAGED_SERVICE_PRINCIPAL_NAME="YouEye managed applications"/);
  assert.match(lifecycle, /umask 077/);
  assert.match(lifecycle, /'\{ :'/);
  assert.match(lifecycle, /\/etc\/youeye-pointer\.env/);
  assert.match(lifecycle, /\/opt\/pointer\/bun/);
  assert.match(lxdDeployer, /signed release artifact/);
  assert.match(lxdDeployer, /test -x .*appDir.*\/bun/);
  assert.doesNotMatch(lxdDeployer, /bun\.sh\/install/);
  assert.match(definitions, /giteaRepo: 'Pointer'/);
  assert.match(definitions, /migrationCommand:/);
  assert.match(definitions, /\/opt\/pointer\/bun \/opt\/pointer\/migrate\.js/);
  assert.match(definitions, /installStyledJsx: false/);
  assert.match(postgres, /'pointer'/);
  assert.match(backup, /'youeye-pointer'/);
  assert.match(backup, /`\$\{YOUEYE_DATA_DIR\}\/pointer\/`/);
  assert.match(staticIps, /'youeye-pointer': 17/);
  assert.match(staticIps, /raw\.dnsmasq/);
  assert.match(security, /Block UI from reaching Pointer directly/);
  assert.match(appNetwork, /block direct Pointer access/);
  assert.match(spineStaticIps, /"youeye-pointer":\s+17/);
});

test('the apex exposes inference only while management remains private and aggregate admin health stays separate', () => {
  const caddy = read('src/lib/caddy/client.ts');
  const admin = read('src/app/api/ai-system/route.ts');
  const adminPage = read('src/app/settings/(shell)/system/ai/page.tsx');
  assert.match(caddy, /path: \['\/v1', '\/v1\/\*', '\/v1beta', '\/v1beta\/\*'\]/);
  const routeSection = caddy.slice(caddy.indexOf('function configurePointerInferenceRoutes'), caddy.indexOf('function canonicalConfig'));
  assert.doesNotMatch(routeSection, /\/api\/|4001/);
  assert.match(admin, /requireAdmin/);
  assert.match(admin, /body\.status === 'ready'/);
  assert.match(admin, /database:/);
  assert.match(admin, /backup: 'included_in_core_backup'/);
  assert.doesNotMatch(admin, /provider-accounts|\/api\/keys|\/api\/groups|\/api\/instances/);
  assert.match(adminPage, /session\?\.isAdmin/);
});
