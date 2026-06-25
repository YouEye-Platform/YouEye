import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 4 — system-app updates through the Market.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/system-app-updates.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('infra defs carry marketSystemId and NO moving-tag imageRef', () => {
  const d = read('src/lib/apps/definitions.ts');
  assert.match(d, /marketSystemId\?: 'postgresql' \| 'caddy' \| 'pihole'/); // interface field
  assert.match(d, /marketSystemId: 'postgresql'/);
  assert.match(d, /marketSystemId: 'caddy'/);
  assert.match(d, /marketSystemId: 'pihole'/);
  // the three moving-tag imageRefs are gone
  assert.doesNotMatch(d, /docker\.io\/library\/postgres:17-alpine/);
  assert.doesNotMatch(d, /docker\.io\/library\/caddy'/);
  assert.doesNotMatch(d, /docker\.io\/pihole\/pihole:latest/);
});

test('unified route detects via planSystemUpdates, flags systemManaged, skips OCI for system apps', () => {
  const c = read('src/app/api/apps/unified/route.ts');
  assert.match(c, /planSystemUpdates/);
  assert.match(c, /systemManaged\?: boolean/);          // interface
  assert.match(c, /systemManaged: !!def\.marketSystemId/); // response
  // OCI branch is gated off for marketSystemId apps (kills the false positive)
  assert.match(c, /def\.updatedBy === 'control-panel' && !lxdResult && !def\.marketSystemId/);
  assert.match(c, /systemPlan\.trackingStatus === 'tracked'/);
});

test('settings update route reroutes marketSystemId apps to updateSystemFromMarket', () => {
  const r = read('src/app/settings/api/apps/[appId]/update/route.ts');
  assert.match(r, /import \{ updateSystemFromMarket \}/);
  assert.match(r, /if \(appDef\?\.marketSystemId\)/);
  assert.match(r, /confirmMaintenanceWindow: body\.confirmMaintenanceWindow === true/);
  assert.match(r, /confirmContainerName:/);
  assert.match(r, /allowDatabaseUpdate: body\.allowDatabaseUpdate === true/);
  assert.match(r, /process\.env\.HOST_IP/);
  // reroute branch happens BEFORE the legacy control-panel/updateOCIApp branch
  assert.ok(
    r.indexOf('if (appDef?.marketSystemId)') < r.indexOf("if (appDef?.updatedBy === 'control-panel')"),
    'system reroute branch must precede the legacy OCI branch',
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
  const ch = read('src/app/api/apps/check-updates/route.ts');
  assert.match(ch, /clearCatalogCache/);
  const ub = read('src/app/api/ui-bridge/apps/route.ts');
  assert.match(ub, /planSystemUpdates/);
  assert.match(ub, /def\.marketSystemId/);
  // the old "OCI disabled for infrastructure" comment is replaced by real detection
  assert.doesNotMatch(ub, /OCI container updates disabled for infrastructure/);
});

test('id mapping: definition id "postgres" maps to market system id "postgresql"', () => {
  const d = read('src/lib/apps/definitions.ts');
  // the postgres def block carries marketSystemId 'postgresql'
  assert.match(d, /id: 'postgres',[\s\S]*?marketSystemId: 'postgresql'/);
});
