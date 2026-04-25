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
import { fetchManifest } from '@/lib/market/catalog';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get('appId');
  if (!appId) {
    return NextResponse.json({ error: 'appId required' }, { status: 400 });
  }

  try {
    const meta = await readInstallMetadata(appId);
    if (!meta) {
      return NextResponse.json({ error: 'App not installed' }, { status: 404 });
    }

    // Find primary container name — prefer 'main' or 'server', fall back to first
    const containers = meta.containers ?? [];
    const primary = containers.find((c: { name: string }) => c.name === 'main' || c.name === 'server')
      || containers[0];
    const primaryContainer = primary?.containerName || `app-${appId}`;

    // Get IP
    const ip = await getContainerIP(primaryContainer);

    // Get port from manifest
    let port = 3000;
    try {
      const manifest = await fetchManifest(appId);
      const primarySpec = manifest.containers?.find((c: { primary?: boolean }) => c.primary) || manifest.containers?.[0];
      if (primarySpec?.port) port = primarySpec.port;
    } catch {
      // Use default port
    }

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
