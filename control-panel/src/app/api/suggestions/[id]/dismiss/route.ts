/**
 * POST /api/suggestions/{id}/dismiss
 * Dismiss a suggestion so it no longer appears in the UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dismissSuggestion } from '@/lib/bridges/suggestions';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: 'Missing suggestion id' }, { status: 400 });
  }

  await dismissSuggestion(id);
  return NextResponse.json({ ok: true });
}
