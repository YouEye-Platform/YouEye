import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks: Caddy/Pi-Hole/Postgres update to the images pinned by the Control Panel.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/system-app-updates.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('infra defs carry systemImageId and NO moving-tag imageRef', () => {
  const d = read('src/lib/apps/definitions.ts');
  assert.match(d, /systemImageId\?: SystemImageId;/); // interface field
  assert.match(d, /systemImageId: 'postgresql'/);
  assert.match(d, /systemImageId: 'caddy'/);
  assert.match(d, /systemImageId: 'pihole'/);
  // the three moving-tag imageRefs are gone
  assert.doesNotMatch(d, /docker\.io\/library\/postgres:17-alpine/);
  assert.doesNotMatch(d, /docker\.io\/library\/caddy'/);
  assert.doesNotMatch(d, /docker\.io\/pihole\/pihole:latest/);
});

test('unified route detects via planSystemUpdates, flags systemManaged, skips OCI for system apps', () => {
  const c = read('src/app/api/apps/unified/route.ts');
  assert.match(c, /planSystemUpdates/);
  assert.match(c, /systemManaged\?: boolean/);          // interface
  assert.match(c, /systemManaged: !!def\.systemImageId/); // response
  // No OCI digest check at all (Plan 11 F3: it covered no app); system apps follow their pinned images
  assert.doesNotMatch(c, /getAllCachedUpdates|ociUpdates|New image available/);
  assert.match(c, /systemPlan\.trackingStatus === 'tracked'/);
});

test('settings update route reroutes systemImageId apps to updateSystemContainer', () => {
  const r = read('src/app/settings/api/apps/[appId]/update/route.ts');
  assert.match(r, /import \{ updateSystemContainer \}/);
  assert.match(r, /if \(appDef\?\.systemImageId\)/);
  assert.match(r, /assertNoCriticalIssues\('Pool\/system operation', undefined, \[/);
  assert.match(r, /confirmMaintenanceWindow: body\.confirmMaintenanceWindow === true/);
  assert.match(r, /confirmContainerName:/);
  assert.match(r, /allowDatabaseUpdate: body\.allowDatabaseUpdate === true/);
  assert.match(r, /process\.env\.HOST_IP/);
  // reroute branch happens BEFORE the control-panel/updateOCIApp branch
  assert.ok(
    r.indexOf('if (appDef?.systemImageId)') < r.indexOf("if (appDef?.updatedBy === 'control-panel')"),
    'system reroute branch must precede the OCI branch',
  );
});

test('apps-client gates system updates behind a confirm dialog with the right body', () => {
  const c = read('src/components/settings-shell/apps-client.tsx');
  assert.match(c, /from "@\/components\/ui\/confirm-dialog"/);
  assert.match(c, /systemManaged\?: boolean/);
  assert.match(c, /app\.systemManaged \? openConfirm\(app\) : updateApp\(app\.id\)/);
  assert.match(c, /confirmMaintenanceWindow: true/);
  assert.match(c, /confirmContainerName: app\.containers\[0\]\?\.name/);
  // postgres-only DB acknowledgement
  assert.match(c, /confirmApp\.id === "postgres"/);
  assert.match(c, /allowDatabaseUpdate: app\.id === "postgres" \? dbAck : undefined/);
});

test('ConfirmDialog primitive exists, dependency-free', () => {
  assert.ok(has('src/components/ui/confirm-dialog.tsx'));
  const cd = read('src/components/ui/confirm-dialog.tsx');
  assert.match(cd, /role="dialog"/);
  assert.match(cd, /confirmDisabled/);
  assert.doesNotMatch(cd, /from ["']@radix-ui/);
});

test('check-updates busts the catalog cache; ui-bridge has market-detection parity', () => {
  // The dedicated check-updates route was folded into POST /api/market/updates,
  // which busts the catalog cache via refreshVersionCheck() -> clearCatalogCache().
  const ch = read('src/app/api/market/updates/route.ts');
  assert.match(ch, /refreshVersionCheck/);
  const ub = read('src/app/api/ui-bridge/apps/route.ts');
  assert.match(ub, /planSystemUpdates/);
  assert.match(ub, /def\.systemImageId/);
  assert.match(ub, /systemManaged: !!def\.systemImageId/);
  // the old "OCI disabled for infrastructure" comment is replaced by real detection
  assert.doesNotMatch(ub, /OCI container updates disabled for infrastructure/);
});

test('id mapping: definition id "postgres" maps to system image id "postgresql"', () => {
  const d = read('src/lib/apps/definitions.ts');
  // the postgres def block carries systemImageId 'postgresql'
  assert.match(d, /id: 'postgres',[\s\S]*?systemImageId: 'postgresql'/);
});

test('the dashboard Apps embed updates through the Settings route with the same acknowledgements', () => {
  const e = read('src/app/embed/apps/client.tsx');
  assert.match(e, /authenticatedFetch\(`\/settings\/api\/apps\/\$\{encodeURIComponent\(appId\)\}\/update`/);
  assert.match(e, /if \(\(systemManaged && !confirm\)/);
  assert.match(e, /confirmMaintenanceWindow: true/);
  assert.match(e, /confirmContainerName: containerName/);
  assert.match(e, /allowDatabaseUpdate: isDatabase \? dbAck : undefined/);
  assert.match(e, /disabled=\{!maintAck \|\| \(isDatabase && !dbAck\)\}/);
  assert.doesNotMatch(e, /ui-bridge\/updates\/\$\{/);
});

test('the legacy component update path is gone on both sides', () => {
  for (const gone of [
    'src/app/api/updates/[component]/route.ts',
    'src/app/settings/api/updates/[component]/route.ts',
    'src/app/api/ui-bridge/updates/[component]/route.ts',
  ]) assert.equal(has(gone), false, gone);
  assert.doesNotMatch(read('src/lib/spine/client.ts'), /updateApp\(|\/api\/update\/app\//);
  const spine = readFileSync(join(repoRoot, '..', 'spine', 'internal', 'api', 'server.go'), 'utf8');
  assert.doesNotMatch(spine, /\/api\/update\/app\/|handleUpdateApp|prepareIncusSnapshot/);
});

test('the UI is never updated by the Control Panel; it updates with the System release', () => {
  const updater = read('src/lib/apps/lxd-updater.ts');
  assert.match(updater, /if \(appDef\.id !== 'pointer'\) \{\s*throw new Error\(`\$\{appDef\.displayName\} updates with the System release\.`\);/);
  assert.doesNotMatch(updater, /PERSISTENT_UI_ENV_PATH|getLatestRelease|release_branch/);
});
