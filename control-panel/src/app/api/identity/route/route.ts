import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { settingsService } from '@/lib/settings';
import * as caddy from '@/lib/caddy/client';
import { getIdentityConfig } from '@/lib/identity/config';

function validSubdomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const subdomain = value.trim().replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain) ? subdomain : null;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const body = await request.json();
  const identity = validSubdomain(body.identitySubdomain);
  if (!identity) {
    return NextResponse.json({ error: 'identitySubdomain is required and must be a valid DNS label' }, { status: 400 });
  }

  const raw = await settingsService.getRaw();
  if (!raw.domain || typeof raw.domain !== 'string') {
    return NextResponse.json({ error: 'Platform domain is not configured' }, { status: 400 });
  }

  const subdomains = {
    ...(raw.subdomains || {}),
    identity,
  };
  await settingsService.setRaw({ subdomains });
  const identityConfig = await getIdentityConfig();
  await caddy.ensureIdentityRoute(`${identity}.${raw.domain}`, identityConfig.containerName, identityConfig.port);

  return NextResponse.json({
    ok: true,
    host: `${identity}.${raw.domain}`,
    subdomains,
  });
}
