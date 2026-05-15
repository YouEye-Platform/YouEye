/**
 * Authentik Stats API
 * GET /api/apps/authentik/stats
 * 
 * Returns Authentik system config (version, etc.)
 */

import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/authentik/client';
import { getContainerIP } from '@/lib/incus/container-ip';

export async function GET() {
  try {
    const ip = await getContainerIP('youeye-authentik');
    if (!ip) {
      return NextResponse.json(
        { error: 'Authentik container not running' },
        { status: 503 }
      );
    }

    const config = await getConfig();
    return NextResponse.json({
      version: config.version_current || config.version,
      build_hash: config.build_hash,
      internal_url: `http://${ip}:9000`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
