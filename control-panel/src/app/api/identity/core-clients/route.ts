import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { settingsService } from '@/lib/settings';
import { spineClient } from '@/lib/spine/client';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
} from '@/lib/identity/core-clients';

async function getExistingUIJwtSecret(): Promise<string | undefined> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile('/var/lib/youeye/ui/.env', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('JWT_SECRET=')) {
        return trimmed.slice('JWT_SECRET='.length) || undefined;
      }
    }
  } catch {
    // Missing UI env means this is a first-time configuration.
  }
  return undefined;
}

export async function POST() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const raw = await settingsService.getRaw();
  const domain = raw.domain;
  if (!domain) {
    return NextResponse.json({ error: 'Platform domain is not configured' }, { status: 400 });
  }
  const subdomains = raw.subdomains || {};
  const controlSub = subdomains.control || 'control';
  const uiSub = subdomains.ui || '';
  const controlExternalUrl = `https://${controlSub}.${domain}`;
  const uiExternalUrl = `https://${uiSub ? `${uiSub}.` : ''}${domain}`;

  const controlClient = await configureControlPanelIdentitySSO({
    controlExternalUrl,
    settingsExternalUrl: `https://${domain}/settings`,
  });

  const status = await spineClient.status();
  let uiClient: { clientId: string; clientSecret: string } | null = null;
  if (status.ui?.installed) {
    const pgCreds = await spineClient.getPostgresCredentials();
    const databaseUrl = `postgresql://${pgCreds.user}:${encodeURIComponent(pgCreds.password)}@${pgCreds.host}:${pgCreds.port}/youeye_ui`;
    uiClient = await configureUIIdentitySSO({
      uiExternalUrl,
      databaseUrl,
      jwtSecret: await getExistingUIJwtSecret(),
    });
  }

  return NextResponse.json({
    ok: true,
    identity: 'youeye-id',
    control: {
      clientId: controlClient.clientId,
      externalUrl: controlExternalUrl,
      settingsUrl: `https://${domain}/settings`,
    },
    ui: uiClient ? {
      clientId: uiClient.clientId,
      externalUrl: uiExternalUrl,
    } : null,
  });
}
