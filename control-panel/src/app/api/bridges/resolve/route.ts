/**
 * GET /api/bridges/resolve?appId=searxng
 *
 * Resolves an app's primary container IP and port.
 * Used by the discovery API to give apps actual reachable addresses
 * for their bridge targets (DNS doesn't work across per-app bridges).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getContainerIP } from '@/lib/incus/container-ip';
import { readInstallMetadata } from '@/lib/market/metadata';
import { readInstalledAppManifest } from '@/lib/market/frozen-manifest';
import { requireAuth } from '@/lib/auth/rbac';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const appId = request.nextUrl.searchParams.get('appId');
  if (!appId) {
    return NextResponse.json({ error: 'appId required' }, { status: 400 });
  }

  try {
    const meta = await readInstallMetadata(appId);
    if (!meta) {
      return NextResponse.json({ error: 'App not installed' }, { status: 404 });
    }

    // The primary container and its port come from the frozen installed manifest; the
    // runtime name is the one the install record holds.
    const manifest = await readInstalledAppManifest(appId);
    const primarySpec = manifest.containers.find((c) => c.primary) || manifest.containers[0];
    const primaryContainer = meta.containers.find((c) => c.name === primarySpec?.name)?.containerName;
    if (!primarySpec?.port || !primaryContainer) {
      return NextResponse.json({ error: 'App has no primary container' }, { status: 409 });
    }
    const port = primarySpec.port;

    // Get IP
    const ip = await getContainerIP(primaryContainer);

    return NextResponse.json({
      appId,
      container: primaryContainer,
      ip: ip || null,
      port,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
