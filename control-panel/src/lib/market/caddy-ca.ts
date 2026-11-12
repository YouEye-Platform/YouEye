import { execShell } from '../incus/server';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { X509Certificate } from 'crypto';
import path from 'path';

const CONTAINER_TRUST_BUNDLE = '/etc/youeye/trust/ca-bundle.crt';
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The app's generated CA directory (`<base>/apps/<id>`; the bundle is in its `trust/`). */
export function caddyTrustAppDirectory(appId: string, baseDir = '/var/lib/youeye'): string {
  if (!APP_ID.test(appId)) throw new Error('Invalid app ID for trust staging');
  return path.join(baseDir, 'apps', appId);
}

/**
 * Remove the app's generated CA directory. It is regenerated on every install, holds no app
 * data, and a leftover copy would make the next install's preflight refuse the app.
 */
export async function removeCaddyTrustBundle(appId: string, baseDir = '/var/lib/youeye'): Promise<void> {
  const directory = caddyTrustAppDirectory(appId, baseDir);
  await rm(directory, { recursive: true, force: true });
  try {
    await lstat(directory);
    throw new Error('Generated CA directory remains after removal');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Platform trust is a current read-only input, never app data to rewind. */
export function isManagedTrustMount(appId: string, device: Record<string, string>): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(appId)
    && device.type === 'disk' && device.path === '/etc/youeye/trust'
    && device.source === `/var/lib/youeye/apps/${appId}/trust`
    && device.readonly === 'true' && device.shift === 'true'
    && Object.keys(device).every(key => ['type', 'path', 'source', 'readonly', 'shift'].includes(key));
}

export function buildTrustBundle(systemBundle: string, caddyRoot: string): string {
  if (!systemBundle.includes('BEGIN CERTIFICATE')) {
    throw new Error('System trust bundle is missing or invalid');
  }
  const root = caddyRoot.trim() + '\n';
  // Parsing rejects truncated/non-certificate input before it is exposed to an
  // application's first process.
  new X509Certificate(root);
  return `${systemBundle.trim()}\n${root}`;
}

/**
 * Build an app-owned complete trust bundle on the host before OCI creation.
 * The caller bind-mounts the returned directory read-only, so every configured
 * CA environment path exists before the application's first process starts.
 */
export async function stageCaddyTrustBundle(appId: string): Promise<{
  hostPath: string;
  containerPath: string;
}> {
  const hostDirectory = `${caddyTrustAppDirectory(appId)}/trust`;
  const [{ stdout: certPem }, systemBundle] = await Promise.all([
    execShell('youeye-caddy', 'cat /data/caddy/pki/authorities/local/root.crt', { timeout: 5_000 }),
    readFile('/etc/ssl/certs/ca-certificates.crt', 'utf8'),
  ]);
  const bundle = buildTrustBundle(systemBundle, certPem || '');
  const hostPath = `${hostDirectory}/ca-bundle.crt`;
  const temporary = `${hostPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(hostDirectory, { recursive: true, mode: 0o755 });
  await writeFile(temporary, bundle, { encoding: 'utf8', mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, hostPath);
  return { hostPath, containerPath: CONTAINER_TRUST_BUNDLE };
}

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
  const escapedService = containerName.replace(/'/g, "'\\''");
  await execShell(containerName,
    `mkdir -p /usr/local/share/ca-certificates/ && ` +
    `echo '${escaped}' > /usr/local/share/ca-certificates/caddy-root.crt && ` +
    `echo '${escaped}' > /tmp/caddy-root.crt && ` +
    `update-ca-certificates 2>/dev/null || true; ` +
    `if [ ! -s '${CONTAINER_TRUST_BUNDLE}' ]; then ` +
    `mkdir -p /etc/youeye/trust && ` +
    `cat /etc/ssl/certs/ca-certificates.crt /tmp/caddy-root.crt > '${CONTAINER_TRUST_BUNDLE}'; ` +
    `fi; ` +
    `if command -v systemctl >/dev/null 2>&1 && systemctl cat '${escapedService}.service' >/dev/null 2>&1; then ` +
    `mkdir -p /etc/systemd/system/${escapedService}.service.d && ` +
    `printf '%s\\n' '[Service]' ` +
    `'Environment=NODE_EXTRA_CA_CERTS=${CONTAINER_TRUST_BUNDLE}' ` +
    `'Environment=SSL_CERT_FILE=${CONTAINER_TRUST_BUNDLE}' ` +
    `'Environment=REQUESTS_CA_BUNDLE=${CONTAINER_TRUST_BUNDLE}' ` +
    `> /etc/systemd/system/${escapedService}.service.d/youeye-caddy-ca.conf && ` +
    `systemctl daemon-reload; ` +
    `fi`,
    { timeout: 10_000 }
  );
}
