/**
 * Health Services API
 *
 * GET /api/health/services — returns health status for all platform services.
 * Requires admin session.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getAllServicesHealth } from '@/lib/health';
// Side-effect import: starts health monitor background job
import '@/lib/health/monitor';
// Side-effect import: starts version checker background job
import '@/lib/market/version-checker';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const services = await getAllServicesHealth();
    return NextResponse.json(services);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Health check failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
