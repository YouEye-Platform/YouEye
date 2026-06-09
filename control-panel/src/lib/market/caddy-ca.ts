import { execShell } from '../incus/server';

/**
 * Inject Caddy's local root CA certificate into an app container trust store.
 * This lets apps call YouEye-managed HTTPS URLs such as https://id.<domain>.
 */
export async function injectCaddyRootCA(containerName: string): Promise<void> {
  const { stdout: certPem } = await execShell(
    'youeye-caddy',
    'cat /data/caddy/pki/authorities/local/root.crt',
    { timeout: 5_000 }
  );
  if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) return;

  const escaped = certPem.replace(/'/g, "'\\''");
  await execShell(containerName,
    `mkdir -p /usr/local/share/ca-certificates/ && ` +
    `echo '${escaped}' > /usr/local/share/ca-certificates/caddy-root.crt && ` +
    `echo '${escaped}' > /tmp/caddy-root.crt && ` +
    `update-ca-certificates 2>/dev/null || true`,
    { timeout: 10_000 }
  );
}
