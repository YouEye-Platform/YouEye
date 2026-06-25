/**
 * Bridge Management API — Single Bridge
 *
 * GET    /api/bridges/:bridgeId — get bridge details
 * PATCH  /api/bridges/:bridgeId — update bridge (toggle direction, activate/deactivate)
 * DELETE /api/bridges/:bridgeId — delete bridge
 */

import { NextResponse } from 'next/server';
import {
  activateBridge,
  deactivateBridge,
  deleteBridge,
} from '@/lib/bridges/manager';
import { getBridge, updateBridge } from '@/lib/bridges/store';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bridgeId: string }> },
) {
  const { bridgeId } = await params;
  const bridge = await getBridge(bridgeId);
  if (!bridge) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ bridge });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bridgeId: string }> },
) {
  const { bridgeId } = await params;
  const body = await request.json();

  if (body.action === 'activate') {
    const bridge = await activateBridge(bridgeId);
    if (!bridge) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ bridge });
  }

  if (body.action === 'deactivate') {
    const bridge = await deactivateBridge(bridgeId);
    if (!bridge) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ bridge });
  }

  if (body.direction) {
    const bridge = await updateBridge(bridgeId, { direction: body.direction });
    if (!bridge) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ bridge });
  }

  return NextResponse.json({ error: 'invalid action' }, { status: 400 });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ bridgeId: string }> },
) {
  const { bridgeId } = await params;
  const deleted = await deleteBridge(bridgeId);
  if (!deleted) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
