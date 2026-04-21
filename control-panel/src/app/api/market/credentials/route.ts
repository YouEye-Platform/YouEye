/**
 * App Credentials API
 *
 * GET /api/market/credentials?app={appId}
 *
 * Returns admin-visible default credentials for an installed app.
 * Only available to authenticated admin users.
 * Reads credential definitions from install.json and secret values from disk.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { readInstallMetadata } from '@/lib/market/metadata';
import { readSecret } from '@/lib/infrastructure/secrets';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const appId = request.nextUrl.searchParams.get('app');
  if (!appId) {
    return NextResponse.json({ error: 'Missing app parameter' }, { status: 400 });
  }

  const metadata = await readInstallMetadata(appId);
  if (!metadata) {
    return NextResponse.json({ error: 'App not installed' }, { status: 404 });
  }

  if (!metadata.credentials || metadata.credentials.length === 0) {
    return NextResponse.json({ credentials: [] });
  }

  const credentials = await Promise.all(
    metadata.credentials.map(async (cred) => {
      const password = await readSecret(`app-${appId}`, `.${cred.passwordSecret}`);
      return {
        label: cred.label,
        username: cred.username,
        password: password ?? '(not found)',
      };
    })
  );

  return NextResponse.json({ credentials });
}
