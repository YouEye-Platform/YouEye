import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { DNS_PROVIDER_DEFINITIONS } from '@/lib/dns-providers/registry';
import { getByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { providerTokenExists } from '@/lib/dns-providers/secrets';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getByoDnsProviderConfig();
  const hasToken = config ? await providerTokenExists(config.connectionId) : false;

  return NextResponse.json({
    providers: DNS_PROVIDER_DEFINITIONS,
    connection: config
      ? {
          provider: config.provider,
          domain: config.domain,
          zoneName: config.zoneName,
          targetIp: config.targetIp,
          hasToken,
          lastDnsSyncAt: config.lastDnsSyncAt || null,
          lastDnsSyncError: config.lastDnsSyncError || null,
          lastCertRenewalAt: config.lastCertRenewalAt || null,
          nextCertRenewalDueAt: config.nextCertRenewalDueAt || null,
        }
      : null,
  });
}
