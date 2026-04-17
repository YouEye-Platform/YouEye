/**
 * Bridge Management API
 *
 * GET  /api/bridges — list all bridges (optional ?appId= filter)
 * POST /api/bridges — create a new bridge
 */

import { NextResponse } from 'next/server';
import {
  createBridge,
  activateBridge,
  loadBridges,
  getBridgesForApp,
} from '@/lib/bridges/manager';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const appId = url.searchParams.get('appId');

  const bridges = appId
    ? await getBridgesForApp(appId)
    : await loadBridges();

  return NextResponse.json({ bridges });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { from, to, direction, envMappings, approvedBy, activate } = body;

  if (!from || !to) {
    return NextResponse.json(
      { error: 'from and to are required' },
      { status: 400 },
    );
  }

  const bridge = await createBridge({
    from,
    to,
    direction: direction || 'one-way',
    envMappings: envMappings || [],
    approvedBy: approvedBy || 'admin',
  });

  if (activate) {
    const activated = await activateBridge(bridge.id);
    return NextResponse.json({ bridge: activated });
  }

  return NextResponse.json({ bridge });
}
