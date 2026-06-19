import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tlsStorage, type StoredCert } from '@/lib/acme/storage';
import { getByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { normalizeDomainInput } from '@/lib/dns-providers/domain';
import { readProviderToken } from '@/lib/dns-providers/secrets';
import type { ByoDnsProviderConfig, DnsProviderId, DnsRecordSummary } from '@/lib/dns-providers/types';

export const BYO_DOMAIN_BUNDLE_TYPE = 'youeye-byo-domain';
export const BYO_DOMAIN_BUNDLE_VERSION = 1;

const DATA_DIR =
  process.env.BYO_DOMAIN_DATA_DIR || '/opt/youeye-control-data/byo-domain';
const IMPORT_FILE = path.join(DATA_DIR, 'import-bundle.json');

export interface ByoDomainBundle {
  type: typeof BYO_DOMAIN_BUNDLE_TYPE;
  version: typeof BYO_DOMAIN_BUNDLE_VERSION;
  domain: string;
  provider: {
    id: DnsProviderId;
    zoneId: string;
    zoneName: string;
  };
  managedRecords: DnsRecordSummary[];
  targetIp?: string;
  tls: StoredCert;
  acme: {
    accountKeyPem: string | null;
  };
  dnsToken: {
    included: boolean;
    value?: string;
  };
  exportedAt: string;
}

export interface SafeByoDomainBundleSummary {
  reuse: boolean;
  domain: string | null;
  provider: { id: DnsProviderId; zoneName: string } | null;
  hasDnsToken: boolean;
  expiresAt: string | null;
  certValid: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUsableCert(cert: StoredCert | null, domain: string): cert is StoredCert {
  if (!cert || cert.mode !== 'acme') return false;
  if (!cert.certPem || !cert.keyPem) return false;
  return cert.domains.includes(domain) && cert.domains.includes(`*.${domain}`);
}

export function isByoDomainBundle(value: unknown): value is ByoDomainBundle {
  if (!isObject(value)) return false;
  if (value.type !== BYO_DOMAIN_BUNDLE_TYPE || value.version !== BYO_DOMAIN_BUNDLE_VERSION) return false;
  if (typeof value.domain !== 'string' || !value.domain.trim()) return false;
  if (!isObject(value.provider)) return false;
  if (value.provider.id !== 'cloudflare') return false;
  if (typeof value.provider.zoneId !== 'string' || !value.provider.zoneId) return false;
  if (typeof value.provider.zoneName !== 'string' || !value.provider.zoneName) return false;
  if (!isObject(value.tls)) return false;
  if (value.tls.mode !== 'acme') return false;
  if (typeof value.tls.certPem !== 'string' || !value.tls.certPem) return false;
  if (typeof value.tls.keyPem !== 'string' || !value.tls.keyPem) return false;
  if (!Array.isArray(value.tls.domains)) return false;
  if (!isObject(value.acme)) return false;
  if (!isObject(value.dnsToken) || typeof value.dnsToken.included !== 'boolean') return false;
  if (value.dnsToken.included && typeof value.dnsToken.value !== 'string') return false;
  return true;
}

export async function exportByoDomainBundle(includeToken = false): Promise<ByoDomainBundle | null> {
  const config = await getByoDnsProviderConfig();
  if (!config || config.mode !== 'byo-provider') return null;

  const domain = normalizeDomainInput(config.domain);
  const cert = await tlsStorage.getCert();
  if (!hasUsableCert(cert, domain)) return null;

  const accountKeyPem = await tlsStorage.getAccountKey();
  const token = includeToken ? await readProviderToken(config.connectionId) : null;

  return {
    type: BYO_DOMAIN_BUNDLE_TYPE,
    version: BYO_DOMAIN_BUNDLE_VERSION,
    domain,
    provider: {
      id: config.provider,
      zoneId: config.zoneId,
      zoneName: config.zoneName,
    },
    managedRecords: config.managedRecords || [],
    targetIp: config.targetIp || undefined,
    tls: cert,
    acme: { accountKeyPem },
    dnsToken: includeToken && token ? { included: true, value: token } : { included: false },
    exportedAt: new Date().toISOString(),
  };
}

export async function getStagedByoDomainBundle(): Promise<ByoDomainBundle | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(IMPORT_FILE, 'utf8'));
    if (!isByoDomainBundle(parsed)) return null;
    return {
      ...parsed,
      domain: normalizeDomainInput(parsed.domain),
    };
  } catch {
    return null;
  }
}

export async function consumeStagedByoDomainBundle(): Promise<void> {
  try {
    await fs.unlink(IMPORT_FILE);
  } catch {
    // Already consumed or never staged.
  }
}

export function byoDomainBundleCertStillValid(bundle: ByoDomainBundle): boolean {
  if (!bundle.tls.expiresAt) return false;
  const expiry = Date.parse(bundle.tls.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - Date.now() > 7 * 24 * 60 * 60 * 1000;
}

export function safeByoDomainBundleSummary(bundle: ByoDomainBundle | null): SafeByoDomainBundleSummary {
  if (!bundle) {
    return { reuse: false, domain: null, provider: null, hasDnsToken: false, expiresAt: null, certValid: false };
  }
  return {
    reuse: true,
    domain: bundle.domain,
    provider: {
      id: bundle.provider.id,
      zoneName: bundle.provider.zoneName,
    },
    hasDnsToken: !!bundle.dnsToken.included,
    expiresAt: bundle.tls.expiresAt || null,
    certValid: byoDomainBundleCertStillValid(bundle),
  };
}

export function bundleToProviderConfig(
  bundle: ByoDomainBundle,
  connectionId: string,
  targetIp: string,
): ByoDnsProviderConfig {
  const expiresAt = Date.parse(bundle.tls.expiresAt);
  const nextRenewal = Number.isNaN(expiresAt)
    ? undefined
    : new Date(expiresAt - 30 * 24 * 60 * 60 * 1000).toISOString();

  return {
    mode: 'byo-provider',
    provider: bundle.provider.id,
    connectionId,
    domain: bundle.domain,
    zoneId: bundle.provider.zoneId,
    zoneName: bundle.provider.zoneName,
    delegated: false,
    managedRecords: bundle.managedRecords || [],
    targetIp,
    lastDnsSyncAt: new Date().toISOString(),
    lastCertRenewalAt: bundle.tls.issuedAt || bundle.exportedAt,
    nextCertRenewalDueAt: nextRenewal,
  };
}

export const BYO_DOMAIN_DATA_DIR = DATA_DIR;
export const BYO_DOMAIN_IMPORT_FILE = IMPORT_FILE;
