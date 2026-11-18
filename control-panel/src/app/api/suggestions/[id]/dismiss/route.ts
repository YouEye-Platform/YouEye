/**
 * POST /api/suggestions/{id}/dismiss
 * Dismiss a suggestion so it no longer appears in the UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dismissSuggestion } from '@/lib/bridges/suggestions';
import { requireAdminCsrf } from '@/lib/auth/rbac';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: 'Missing suggestion id' }, { status: 400 });
  }

  await dismissSuggestion(id);
  return NextResponse.json({ ok: true });
}
