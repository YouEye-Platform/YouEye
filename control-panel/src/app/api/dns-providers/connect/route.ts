import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { createConnectionId, getByoDnsProviderConfig, saveByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { managedAddressNames } from '@/lib/dns-providers/domain';
import { deleteProviderToken, writeProviderToken } from '@/lib/dns-providers/secrets';
import { syncByoDomainDns } from '@/lib/dns-providers/sync';
import { validateDnsProvider } from '@/lib/dns-providers/validation';
import { settingsService } from '@/lib/settings';
import type { ByoDnsProviderConfig } from '@/lib/dns-providers/types';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const provider = body.provider === 'cloudflare' ? 'cloudflare' : null;
    const domain = typeof body.domain === 'string' ? body.domain : '';
    const token = typeof body.token === 'string' ? body.token : '';
    if (!provider) return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
    if (!token.trim()) return NextResponse.json({ error: 'Token is required' }, { status: 400 });

    const validation = await validateDnsProvider({ provider, domain, token, writeTest: true });
    if (!validation.ok || !validation.zone) {
      return NextResponse.json(validation, { status: 400 });
    }

    try {
      const settings = await settingsService.getRaw();
      const configuredDomain = typeof settings.domain === 'string'
        ? settings.domain.trim().toLowerCase().replace(/\.+$/, '')
        : '';
      if (settings.setup_completed && configuredDomain && configuredDomain !== validation.domain) {
        return NextResponse.json(
          { error: 'Change the platform domain before connecting a DNS provider for it.' },
          { status: 409 },
        );
      }
    } catch (error) {
      console.warn('[dns-provider/connect] could not compare configured domain:', error);
    }

    const previousConfig = await getByoDnsProviderConfig();
    const connectionId = createConnectionId();
    await writeProviderToken(connectionId, token);
    const targetIp = process.env.HOST_IP || '';
    const config: ByoDnsProviderConfig = {
      mode: 'byo-provider',
      provider,
      connectionId,
      domain: validation.domain,
      zoneId: validation.zone.id,
      zoneName: validation.zone.name,
      delegated: false,
      managedRecords: managedAddressNames(validation.domain).map((name) => ({
        type: 'A',
        name,
        content: targetIp,
      })),
      targetIp,
    };
    await saveByoDnsProviderConfig(config);

    const sync = await syncByoDomainDns('connect', targetIp);
    if (!sync.ok) {
      return NextResponse.json({ ...validation, sync }, { status: 500 });
    }
    if (previousConfig?.connectionId && previousConfig.connectionId !== connectionId) {
      await deleteProviderToken(previousConfig.connectionId).catch((error) => {
        console.error('[dns-provider/connect] failed to delete old provider token:', error);
      });
    }

    return NextResponse.json({
      ok: true,
      provider,
      domain: validation.domain,
      zone: validation.zone,
      plannedRecords: validation.plannedRecords,
      sync,
    });
  } catch (error) {
    console.error('[dns-provider/connect] failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect DNS provider' },
      { status: 500 },
    );
  }
}
