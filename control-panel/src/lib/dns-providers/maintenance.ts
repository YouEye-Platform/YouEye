import { tlsStorage } from '@/lib/acme/storage';
import { issueCertificateWithDnsProvider } from '@/lib/acme/client';
import * as caddy from '@/lib/caddy/client';
import { CloudflareDnsProvider } from './cloudflare';
import { getByoDnsProviderConfig, saveByoDnsProviderConfig } from './config';
import { readProviderToken } from './secrets';

const RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let started = false;

export async function renewProviderCertificateIfNeeded(force = false): Promise<{ renewed: boolean; reason: string }> {
  const config = await getByoDnsProviderConfig();
  if (!config || config.mode !== 'byo-provider') return { renewed: false, reason: 'No provider configured' };

  const cert = await tlsStorage.getCert();
  if (!force && cert?.expiresAt) {
    const expiresAt = new Date(cert.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > RENEW_WINDOW_MS) {
      return { renewed: false, reason: 'Certificate is not due yet' };
    }
  }

  const token = await readProviderToken(config.connectionId);
  if (!token) throw new Error('DNS provider token is not available');
  if (config.provider !== 'cloudflare') throw new Error(`Unsupported DNS provider: ${config.provider}`);

  const provider = new CloudflareDnsProvider(token);
  const zone = { id: config.zoneId, name: config.zoneName };
  const result = await issueCertificateWithDnsProvider(config.domain, provider, zone, true);
  await caddy.loadExternalCert(result.certificate, result.privateKey, result.domains);

  const expiresAt = new Date(result.expiresAt);
  const nextRenewal = new Date(expiresAt.getTime() - RENEW_WINDOW_MS);
  await saveByoDnsProviderConfig({
    ...config,
    lastCertRenewalAt: new Date().toISOString(),
    nextCertRenewalDueAt: nextRenewal.toISOString(),
    lastDnsSyncError: '',
  });

  return { renewed: true, reason: 'Certificate renewed' };
}

export function startDnsProviderMaintenanceLoop(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    void renewProviderCertificateIfNeeded().catch((error) => {
      console.error('[dns-provider/maintenance] startup renewal check failed:', error);
    });
  }, 60_000);
  setInterval(() => {
    void renewProviderCertificateIfNeeded().catch((error) => {
      console.error('[dns-provider/maintenance] renewal check failed:', error);
    });
  }, CHECK_INTERVAL_MS);
}
