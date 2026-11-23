import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const controlRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function readControl(path: string): string {
  return path.endsWith(".tsx") ? englishInterfaceSource(readFileSync(join(controlRoot, path), "utf8")) : readFileSync(join(controlRoot, path), "utf8");
}

test('settings system page surfaces the pinned core image plans safely', () => {
  const client = readControl('src/components/settings-shell/system-client.tsx');
  const api = readControl('src/app/api/deploy/infrastructure/system-updates/route.ts');
  const settingsApi = readControl('src/app/settings/api/deploy/infrastructure/system-updates/route.ts');
  const updater = readControl('src/lib/infrastructure/system-updater.ts');

  // The pinned images sit under a folded "Advanced: container images" on Services.
  assert.match(client, /<details[\s\S]*t\("images\.summary"\)/);
  assert.ok(client.includes('/settings/api/deploy/infrastructure/system-updates'));
  assert.match(client, /"untracked"/);
  assert.match(client, /adoptUntracked: plan\.trackingStatus !== "tracked"/);
  assert.match(client, /allowDatabaseUpdate: plan\.id === "postgresql"/);
  assert.match(client, /confirmMaintenanceWindow: true/);
  assert.match(client, /confirmContainerName: plan\.containerName/);
  assert.match(client, /Database image changes require an explicit maintenance window/);
  assert.match(client, /t\("images\.dryRun"\)/);
  assert.match(client, /t\("images\.adopt"\)/);
  assert.match(client, /Type(?:\{" "\})?\s*\{confirmPlan\.containerName\} to continue/);
  assert.match(client, /I have a maintenance window/);

  assert.match(api, /planSystemUpdates/);
  assert.match(api, /updateSystemContainer/);
  assert.match(api, /process\.env\.HOST_IP/);
  assert.match(updater, /confirmMaintenanceWindow/);
  assert.match(updater, /confirmContainerName !== plan\.containerName/);
  assert.match(updater, /stop and recreate critical infrastructure containers/);
  assert.match(settingsApi, /@\/app\/api\/deploy\/infrastructure\/system-updates\/route/);
});
