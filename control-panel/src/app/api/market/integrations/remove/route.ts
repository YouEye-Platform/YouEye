import { NextRequest, NextResponse } from 'next/server';
import { removeIntegration } from '@/lib/market/integration-runner';
import type { InstallEvent } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: { integrationId?: string; sourceId?: string; metadataOnly?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.integrationId) {
    return NextResponse.json({ error: 'Missing integrationId' }, { status: 400 });
  }

  const events: InstallEvent[] = [];
  try {
    const result = await removeIntegration(
      { integrationId: body.integrationId, sourceId: body.sourceId, metadataOnly: body.metadataOnly },
      (event) => events.push(event)
    );
    return NextResponse.json({ success: true, result, events });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      events,
    }, { status: 500 });
  }
}
