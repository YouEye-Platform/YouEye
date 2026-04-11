/**
 * Authentik post-deployment setup.
 * Creates API token in database and configures Caddy reverse proxy route.
 */

import { execShell } from '../incus/server';
import { readSecret } from './secrets';
import { getContainerIP } from './oci-deployer';

/**
 * Create / update the Authentik API token in the database.
 * The AUTHENTIK_BOOTSTRAP_TOKEN env var does not always work in Incus OCI containers,
 * so we insert directly via PostgreSQL. Waits for akadmin user to be bootstrapped.
 */
export async function createAuthentikAPIToken(): Promise<void> {
  const token = await readSecret('authentik', '.bootstrap_token');
  if (!token) throw new Error('Bootstrap token not found');

  // Wait for akadmin user to appear (created async after server health check)
  let userID = '';
  for (let i = 0; i < 24; i++) {
    const result = await execShell(
      'youeye-postgres',
      "psql -U youeye -d authentik -tAc \"SELECT id FROM authentik_core_user WHERE username='akadmin'\"",
      { timeout: 10_000 }
    );
    userID = result.stdout.trim();
    if (userID) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!userID) {
    throw new Error('akadmin user not found after 120s');
  }

  // Insert or update the API token
  const sql = `INSERT INTO authentik_core_token (token_uuid, expires, expiring, description, user_id, intent, identifier, key, managed)
VALUES (gen_random_uuid(), NULL, false, 'YouEye API Token', ${userID}, 'api', 'youeye-api', '${token}', '')
ON CONFLICT (identifier) DO UPDATE SET key='${token}'`;

  const result = await execShell('youeye-postgres', `psql -U youeye -d authentik -c "${sql}"`, {
    timeout: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to insert API token: ${result.stderr}`);
  }
}

/**
 * Add a Caddy reverse proxy route for Authentik.
 * Routes auth.youeye.local → youeye-authentik:9000
 */
export async function setupCaddyAuthentikRoute(): Promise<void> {
  const caddyIP = await getContainerIP('youeye-caddy');
  if (!caddyIP) throw new Error('Caddy container not running');

  const authentikIP = await getContainerIP('youeye-authentik');
  if (!authentikIP) throw new Error('Authentik container not running');

  const routeConfig = {
    match: [{ host: ['auth.youeye.local'] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${authentikIP}:9000` }],
      },
    ],
  };

  // First verify Caddy admin API is reachable
  const checkResp = await fetch(`http://${caddyIP}:2019/config/`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!checkResp.ok) throw new Error('Caddy admin API not reachable');

  // Try adding route to existing server
  try {
    const resp = await fetch(
      `http://${caddyIP}:2019/config/apps/http/servers/srv0/routes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routeConfig),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (resp.ok) return;
  } catch { /* srv0 doesn't exist yet */ }

  // Create initial server config with the route
  const serverConfig = {
    listen: [':80'],
    routes: [routeConfig],
  };

  const resp = await fetch(
    `http://${caddyIP}:2019/config/apps/http/servers/authentik`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverConfig),
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to create Caddy server for Authentik: ${resp.status}`);
  }
}
