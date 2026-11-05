export type DnsProviderId = 'cloudflare';

export interface ProviderHelpStep {
  title: string;
  body: string;
}

export interface DnsProviderDefinition {
  id: DnsProviderId;
  label: string;
  tokenLabel: string;
  docsUrl: string;
  requiredPermissions: string[];
  helpSteps: ProviderHelpStep[];
  capabilities: {
    aRecords: boolean;
    wildcardRecords: boolean;
    txtRecords: boolean;
    zoneAutoDetect: boolean;
  };
}

export interface ZoneRef {
  id: string;
  name: string;
}

export interface ProviderAccountSummary {
  status: string;
  id?: string;
}

export interface DnsRecordSummary {
  id?: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

export interface DelegationCheckInput {
  domain: string;
  zone: ZoneRef;
}

export interface DelegationCheckResult {
  delegated: boolean;
  nameservers: string[];
  reason?: string;
}

export interface AddressRecordInput {
  zone: ZoneRef;
  name: string;
  ip: string;
}

export interface TxtRecordInput {
  zone: ZoneRef;
  name: string;
  value: string;
  ttl?: number;
}

export interface RecordChangeResult {
  name: string;
  type: 'A' | 'TXT';
  action: 'created' | 'updated' | 'unchanged' | 'deleted';
  recordId?: string;
}

export interface DnsProviderClient {
  validateCredentials(): Promise<ProviderAccountSummary>;
  findZoneForDomain(domain: string): Promise<ZoneRef>;
  detectDelegation(input: DelegationCheckInput): Promise<DelegationCheckResult>;
  listRecords(zone: ZoneRef, name: string, type?: string): Promise<DnsRecordSummary[]>;
  ensureAddressRecord(input: AddressRecordInput): Promise<RecordChangeResult[]>;
  ensureTxtRecord(input: TxtRecordInput): Promise<RecordChangeResult>;
  deleteTxtRecord(input: TxtRecordInput & { recordId?: string }): Promise<void>;
}

export interface ByoDnsProviderConfig {
  mode: 'byo-provider';
  provider: DnsProviderId;
  connectionId: string;
  domain: string;
  zoneId: string;
  zoneName: string;
  delegated: boolean;
  managedRecords: DnsRecordSummary[];
  targetIp: string;
  lastDnsSyncAt?: string;
  lastDnsSyncError?: string;
  lastCertRenewalAt?: string;
  nextCertRenewalDueAt?: string;
}

export interface ProviderValidationResult {
  ok: boolean;
  provider: DnsProviderId;
  domain: string;
  zone: ZoneRef | null;
  account: ProviderAccountSummary | null;
  plannedRecords: string[];
  existingRecords: {
    apex: DnsRecordSummary[];
    wildcard: DnsRecordSummary[];
  };
  conflicts: DnsRecordSummary[];
  warnings: string[];
  error?: string;
}
