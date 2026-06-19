import crypto from 'crypto';
import { CloudflareDnsProvider } from './cloudflare';
import { managedAddressNames, normalizeDomainInput } from './domain';
import type { DnsProviderId, ProviderValidationResult, ZoneRef } from './types';

const CONFLICT_TYPES = new Set(['CNAME', 'NS']);

export interface ValidateProviderInput {
  provider: DnsProviderId;
  domain: string;
  token: string;
  writeTest?: boolean;
}

export async function validateDnsProvider(input: ValidateProviderInput): Promise<ProviderValidationResult> {
  const domain = normalizeDomainInput(input.domain);
  const plannedRecords = managedAddressNames(domain);

  if (input.provider !== 'cloudflare') {
    throw new Error(`Unsupported DNS provider: ${input.provider}`);
  }

  const client = new CloudflareDnsProvider(input.token);
  let zone: ZoneRef | null = null;

  try {
    const account = await client.validateCredentials();
    zone = await client.findZoneForDomain(domain);
    const delegation = await client.detectDelegation({ domain, zone });
    if (delegation.delegated) {
      return {
        ok: false,
        provider: input.provider,
        domain,
        zone,
        account,
        plannedRecords,
        existingRecords: { apex: [], wildcard: [] },
        conflicts: [],
        warnings: [],
        error: `${domain} is delegated to another DNS zone. Connect that zone instead, or choose a name that is not delegated.`,
      };
    }

    if (input.writeTest !== false) {
      const nonce = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const txtName = `_youeye-validate-${nonce}.${domain}`;
      const txtValue = `youeye-provider-validation-${crypto.randomBytes(12).toString('hex')}`;
      const created = await client.ensureTxtRecord({ zone, name: txtName, value: txtValue, ttl: 60 });
      const found = await client.listRecords(zone, txtName, 'TXT');
      const matched = found.some((record) => record.id === created.recordId && record.content.replace(/^"|"$/g, '') === txtValue);
      await client.deleteTxtRecord({ zone, name: txtName, value: txtValue, recordId: created.recordId });
      if (!matched) throw new Error('Temporary DNS record could not be read back');
    }

    const [apex, wildcard] = await Promise.all([
      client.listRecords(zone, plannedRecords[0]),
      client.listRecords(zone, plannedRecords[1]),
    ]);
    const conflicts = [...apex, ...wildcard].filter((record) => CONFLICT_TYPES.has(record.type));

    return {
      ok: conflicts.length === 0,
      provider: input.provider,
      domain,
      zone,
      account,
      plannedRecords,
      existingRecords: { apex, wildcard },
      conflicts,
      warnings: conflicts.length > 0 ? ['Some records must be removed before YouEye can manage this domain.'] : [],
      error: conflicts.length > 0 ? `${conflicts[0].name} has a ${conflicts[0].type} record that blocks automatic setup.` : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      provider: input.provider,
      domain,
      zone,
      account: null,
      plannedRecords,
      existingRecords: { apex: [], wildcard: [] },
      conflicts: [],
      warnings: [],
      error: error instanceof Error ? error.message : 'Provider validation failed',
    };
  }
}
