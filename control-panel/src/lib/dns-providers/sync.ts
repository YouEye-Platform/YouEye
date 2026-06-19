import { setDomainDNS } from '@/lib/apps/pihole-api';
import { CloudflareDnsProvider } from './cloudflare';
import { getByoDnsProviderConfig, saveByoDnsProviderConfig } from './config';
import { managedAddressNames, normalizeDomainInput } from './domain';
import { readProviderToken } from './secrets';
import type { ByoDnsProviderConfig, RecordChangeResult, ZoneRef } from './types';

export interface DnsSyncResult {
  ok: boolean;
  domain: string | null;
  targetIp: string | null;
  changes: RecordChangeResult[];
  error?: string;
}

export async function syncByoDomainDns(reason: string, targetIp = process.env.HOST_IP || ''): Promise<DnsSyncResult> {
  const config = await getByoDnsProviderConfig();
  if (!config || config.mode !== 'byo-provider') {
    return { ok: true, domain: null, targetIp: targetIp || null, changes: [] };
  }
  if (!targetIp) {
    return { ok: false, domain: config.domain, targetIp: null, changes: [], error: 'HOST_IP is not available' };
  }

  try {
    const token = await readProviderToken(config.connectionId);
    if (!token) throw new Error('DNS provider token is not available');
    if (config.provider !== 'cloudflare') throw new Error(`Unsupported DNS provider: ${config.provider}`);

    const client = new CloudflareDnsProvider(token);
    const domain = normalizeDomainInput(config.domain);
    const zone: ZoneRef = { id: config.zoneId, name: config.zoneName };
    const changes: RecordChangeResult[] = [];
    for (const name of managedAddressNames(domain)) {
      changes.push(...await client.ensureAddressRecord({ zone, name, ip: targetIp }));
    }

    try {
      await setDomainDNS(domain, targetIp);
    } catch (error) {
      console.error(`[dns-provider] Pi-hole sync failed during ${reason}:`, error);
    }

    const nextConfig: ByoDnsProviderConfig = {
      ...config,
      domain,
      targetIp,
      managedRecords: changes.map((change) => ({
        id: change.recordId,
        type: change.type,
        name: change.name,
        content: targetIp,
      })),
      lastDnsSyncAt: new Date().toISOString(),
      lastDnsSyncError: '',
    };
    await saveByoDnsProviderConfig(nextConfig);
    return { ok: true, domain, targetIp, changes };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DNS sync failed';
    await saveByoDnsProviderConfig({
      ...config,
      lastDnsSyncError: message,
    });
    return { ok: false, domain: config.domain, targetIp, changes: [], error: message };
  }
}
