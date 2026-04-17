/**
 * GET /api/connectors/:connectorId/manifest — Get full connector manifest
 * Used by YE-UI to forward manifest to connector runtime during proxy requests.
 */

import { NextResponse } from 'next/server';
import { fetchConnectorManifest } from '@/lib/connectors/registry';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ connectorId: string }> }
) {
  const { connectorId } = await params;

  try {
    const manifest = await fetchConnectorManifest(connectorId);
    return NextResponse.json({ manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Manifest not found';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
