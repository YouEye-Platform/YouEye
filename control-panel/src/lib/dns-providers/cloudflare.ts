import { candidateZonesForDomain, hasPublicNsAtName } from './domain';
import type {
  AddressRecordInput,
  DelegationCheckInput,
  DelegationCheckResult,
  DnsProviderClient,
  DnsRecordSummary,
  ProviderAccountSummary,
  RecordChangeResult,
  TxtRecordInput,
  ZoneRef,
} from './types';

interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

interface CloudflareZone {
  id: string;
  name: string;
  status?: string;
}

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

const API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareDnsProvider implements DnsProviderClient {
  constructor(private readonly token: string) {}

  async validateCredentials(): Promise<ProviderAccountSummary> {
    const result = await this.request<{ id?: string; status?: string }>('/user/tokens/verify');
    return {
      id: result.id,
      status: result.status || 'active',
    };
  }

  async findZoneForDomain(domain: string): Promise<ZoneRef> {
    for (const candidate of candidateZonesForDomain(domain)) {
      const params = new URLSearchParams({ name: candidate, per_page: '50' });
      const zones = await this.request<CloudflareZone[]>(`/zones?${params}`);
      const zone = zones.find((item) => item.name === candidate);
      if (zone) return { id: zone.id, name: zone.name };
    }
    throw new Error('This token cannot access the DNS zone for that domain');
  }

  async detectDelegation(input: DelegationCheckInput): Promise<DelegationCheckResult> {
    if (input.domain === input.zone.name) {
      return { delegated: false, nameservers: [] };
    }

    const providerNs = await this.listRecords(input.zone, input.domain, 'NS');
    if (providerNs.length > 0) {
      return {
        delegated: true,
        nameservers: providerNs.map((record) => record.content),
        reason: 'The name has NS records in the parent zone',
      };
    }

    const publicNs = await hasPublicNsAtName(input.domain);
    if (publicNs.length > 0) {
      return {
        delegated: true,
        nameservers: publicNs,
        reason: 'Public DNS reports authoritative nameservers at this name',
      };
    }

    return { delegated: false, nameservers: [] };
  }

  async listRecords(zone: ZoneRef, name: string, type?: string): Promise<DnsRecordSummary[]> {
    const params = new URLSearchParams({ name, per_page: '100' });
    if (type) params.set('type', type);
    const records = await this.request<CloudflareRecord[]>(`/zones/${zone.id}/dns_records?${params}`);
    return records.map(toSummary);
  }

  async ensureAddressRecord(input: AddressRecordInput): Promise<RecordChangeResult[]> {
    const existing = await this.listRecords(input.zone, input.name);
    const conflicts = existing.filter((record) => record.type === 'CNAME' || record.type === 'NS');
    if (conflicts.length > 0) {
      throw new Error(`${input.name} has a ${conflicts[0].type} record that conflicts with an A record`);
    }

    const aRecords = existing.filter((record) => record.type === 'A');
    if (aRecords.length === 0) {
      const created = await this.createRecord(input.zone, {
        type: 'A',
        name: input.name,
        content: input.ip,
        ttl: 1,
        proxied: false,
        comment: 'Managed by YouEye',
      });
      return [{ type: 'A', name: created.name, action: 'created', recordId: created.id }];
    }

    const changes: RecordChangeResult[] = [];
    for (const record of aRecords) {
      if (record.content === input.ip && record.proxied === false) {
        changes.push({ type: 'A', name: record.name, action: 'unchanged', recordId: record.id });
        continue;
      }
      await this.updateRecord(input.zone, record.id!, {
        type: 'A',
        name: input.name,
        content: input.ip,
        ttl: record.ttl || 1,
        proxied: false,
        comment: 'Managed by YouEye',
      });
      changes.push({ type: 'A', name: record.name, action: 'updated', recordId: record.id });
    }
    return changes;
  }

  async ensureTxtRecord(input: TxtRecordInput): Promise<RecordChangeResult> {
    const existing = await this.listRecords(input.zone, input.name, 'TXT');
    const match = existing.find((record) => stripTxtQuotes(record.content) === input.value);
    if (match) {
      return { type: 'TXT', name: match.name, action: 'unchanged', recordId: match.id };
    }
    const created = await this.createRecord(input.zone, {
      type: 'TXT',
      name: input.name,
      content: input.value,
      ttl: input.ttl || 60,
      comment: 'Temporary YouEye certificate validation',
    });
    return { type: 'TXT', name: created.name, action: 'created', recordId: created.id };
  }

  async deleteTxtRecord(input: TxtRecordInput & { recordId?: string }): Promise<void> {
    if (input.recordId) {
      await this.deleteRecord(input.zone, input.recordId);
      return;
    }
    const existing = await this.listRecords(input.zone, input.name, 'TXT');
    await Promise.all(
      existing
        .filter((record) => stripTxtQuotes(record.content) === input.value)
        .map((record) => this.deleteRecord(input.zone, record.id!)),
    );
  }

  private async createRecord(zone: ZoneRef, body: Record<string, unknown>): Promise<DnsRecordSummary> {
    const record = await this.request<CloudflareRecord>(`/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return toSummary(record);
  }

  private async updateRecord(zone: ZoneRef, recordId: string, body: Record<string, unknown>): Promise<DnsRecordSummary> {
    const record = await this.request<CloudflareRecord>(`/zones/${zone.id}/dns_records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return toSummary(record);
  }

  private async deleteRecord(zone: ZoneRef, recordId: string): Promise<void> {
    await this.request(`/zones/${zone.id}/dns_records/${recordId}`, { method: 'DELETE' });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const body = await res.json().catch(() => null) as CloudflareResponse<T> | null;
    if (!res.ok || !body?.success) {
      const message = body?.errors?.map((error) => error.message || error.code).filter(Boolean).join('; ');
      throw new Error(message || `Cloudflare request failed with HTTP ${res.status}`);
    }
    return body.result;
  }
}

function toSummary(record: CloudflareRecord): DnsRecordSummary {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  };
}

function stripTxtQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
}
