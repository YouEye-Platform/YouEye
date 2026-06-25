/**
 * Setup Steps API
 *
 * GET /api/setup/steps — returns persisted setup step completion state.
 * DELETE /api/setup/steps?step=dns — clears a specific step (for retry).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { spineClient } from '@/lib/spine/client';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const raw = await spineClient.getConfig();
    const steps = (raw as Record<string, unknown>).setup_steps || {};
    return NextResponse.json(steps);
  } catch {
    return NextResponse.json({});
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const stepId = request.nextUrl.searchParams.get('step');
  if (!stepId) {
    return NextResponse.json({ error: 'Missing step parameter' }, { status: 400 });
  }

  try {
    const raw = await spineClient.getConfig();
    const steps = { ...((raw as Record<string, unknown>).setup_steps as Record<string, string> || {}) };
    delete steps[stepId];
    await spineClient.patchConfig({ setup_steps: steps });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clear step';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
