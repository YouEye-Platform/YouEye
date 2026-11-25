/**
 * Bridge Management API — Single Bridge
 *
 * GET    /api/bridges/:bridgeId — get bridge details
 * PATCH  /api/bridges/:bridgeId — update bridge (toggle direction, activate/deactivate)
 * DELETE /api/bridges/:bridgeId — delete bridge
 */

import { userOperationResponse } from '@/lib/http/lifecycle-busy';
import { NextResponse } from 'next/server';
import {
  activateBridge,
  deactivateBridge,
  deleteBridge,
  setBridgeDirection,
} from '@/lib/bridges/manager';
import { getBridge } from '@/lib/bridges/store';
import { suggestAgainAfterDisconnect } from '@/lib/bridges/suggestions';
import { requireAdminCsrf, requireAdmin } from '@/lib/auth/rbac';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bridgeId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

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
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;
  return userOperationResponse('Changing a connection', async () => {

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
      if (body.direction !== 'one-way' && body.direction !== 'both-ways') {
        return NextResponse.json({ error: 'invalid direction' }, { status: 400 });
      }
      // Through the manager: an active connection's reverse grant and both UI rows follow the new direction.
      const bridge = await setBridgeDirection(bridgeId, body.direction);
      if (!bridge) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return NextResponse.json({ bridge });
    }

    return NextResponse.json({ error: 'invalid action' }, { status: 400 });
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bridgeId: string }> },
) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;
  return userOperationResponse('Removing a connection', async () => {

    const { bridgeId } = await params;
    const bridge = await getBridge(bridgeId);
    const deleted = await deleteBridge(bridgeId);
    if (!deleted) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    // The connection can be approved again from the app's page (YE-227); the disconnect stands if this fails.
    let suggested = false;
    if (bridge) {
      try {
        suggested = await suggestAgainAfterDisconnect(bridge.from, bridge.to);
      } catch (err) {
        console.error(`[bridges] Could not suggest ${bridge.from} → ${bridge.to} again:`, err);
      }
    }
    return NextResponse.json({ ok: true, suggested });
  });
}
