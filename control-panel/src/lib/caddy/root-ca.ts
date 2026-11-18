import { X509Certificate } from 'node:crypto';
import { execShell } from '@/lib/incus/server';

/** Caddy's internal root CA (PEM), the certificate the setup surface offers for download; null when absent. */
export async function readCaddyRootCertificate(): Promise<string | null> {
  const result = await execShell('youeye-caddy', 'cat /data/caddy/pki/authorities/local/root.crt', { timeout: 10000 });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}

/** SHA-256 of the certificate's DER, as colon-separated uppercase hex (`AA:BB:…`), the format the console shows. */
export function certificateFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256.toUpperCase();
}
