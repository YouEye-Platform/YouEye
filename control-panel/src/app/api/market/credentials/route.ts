/**
 * App Credentials API
 *
 * GET /api/market/credentials?app={appId}
 *
 * Returns admin-visible default credentials for an installed app.
 * Administrators only: these are the apps' generated admin passwords.
 * Reads credential definitions from install.json and secret values from disk.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { readInstallMetadata } from '@/lib/market/metadata';
import { isAppSecretName, readAppSecret } from '@/lib/infrastructure/secrets';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

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
      const password = isAppSecretName(cred.passwordSecret)
        ? await readAppSecret(appId, cred.passwordSecret)
        : null;
      return {
        label: cred.label,
        username: cred.username,
        password: password ?? '(not found)',
      };
    })
  );

  return NextResponse.json({ credentials });
}
