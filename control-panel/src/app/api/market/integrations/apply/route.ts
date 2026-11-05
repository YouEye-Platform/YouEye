import { NextRequest, NextResponse } from 'next/server';
import { applyIntegration } from '@/lib/market/integration-runner';
import { requireAdmin } from '@/lib/auth/rbac';
import type { InstallEvent } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  let body: { integrationId?: string; sourceId?: string };
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
    const result = await applyIntegration(
      { integrationId: body.integrationId, sourceId: body.sourceId },
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
