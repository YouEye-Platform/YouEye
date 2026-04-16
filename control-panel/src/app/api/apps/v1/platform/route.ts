import { NextResponse } from 'next/server';
import { validateAppToken } from '@/lib/apps/gateway-token';
import { getPlatformContext } from '@/lib/market/platform-env';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const identity = await validateAppToken(token);
  if (!identity) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

  const platform = await getPlatformContext();
  return NextResponse.json({
    version: platform.version,
    domain: platform.domain,
    locale: platform.locale,
    timezone: platform.timezone,
    site_name: platform.siteName,
    container_domain: CONTAINER_DOMAIN,
  });
}
