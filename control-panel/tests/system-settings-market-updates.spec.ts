import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const controlRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function readControl(path: string): string {
  return readFileSync(join(controlRoot, path), 'utf8');
}

test('settings system page surfaces Market system update plans safely', () => {
  const client = readControl('src/components/settings-shell/system-client.tsx');
  const api = readControl('src/app/api/deploy/infrastructure/system-updates/route.ts');
  const settingsApi = readControl('src/app/settings/api/deploy/infrastructure/system-updates/route.ts');
  const updater = readControl('src/lib/infrastructure/system-updater.ts');

  assert.match(client, /Market System Manifests/);
  assert.ok(client.includes('/settings/api/deploy/infrastructure/system-updates'));
  assert.match(client, /legacy-compatible/);
  assert.match(client, /legacy-untracked/);
  assert.match(client, /forceLegacy: plan\.trackingStatus !== "tracked"/);
  assert.match(client, /allowDatabaseUpdate: plan\.id === "postgresql"/);
  assert.match(client, /confirmMaintenanceWindow: true/);
  assert.match(client, /confirmContainerName: plan\.containerName/);
  assert.match(client, /Database image changes require an explicit maintenance window/);
  assert.match(client, /Dry Run/);
  assert.match(client, /Adopt\/Recreate/);
  assert.match(client, /Type \{confirmPlan\.containerName\} to continue/);
  assert.match(client, /I have a maintenance window/);

  assert.match(api, /planSystemUpdates/);
  assert.match(api, /updateSystemFromMarket/);
  assert.match(api, /process\.env\.HOST_IP/);
  assert.match(updater, /confirmMaintenanceWindow/);
  assert.match(updater, /confirmContainerName !== plan\.containerName/);
  assert.match(updater, /stop and recreate critical infrastructure containers/);
  assert.match(settingsApi, /@\/app\/api\/deploy\/infrastructure\/system-updates\/route/);
});
