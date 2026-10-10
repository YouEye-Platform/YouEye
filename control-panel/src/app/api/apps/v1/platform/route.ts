import { NextResponse } from 'next/server';
import { validateAppToken } from '@/lib/apps/gateway-token';
import { getPlatformContext } from '@/lib/market/platform-env';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { parseAppBearer } from '../../../../../../../shared/app-service-credential';

export async function GET(request: Request) {
  if (request.headers.has('x-ui-bridge-token') || request.headers.has('x-app-slug')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const token = parseAppBearer(request.headers);
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const identity = await validateAppToken(token, request.headers.get('x-youeye-app') ?? '');
  if (!identity) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

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
