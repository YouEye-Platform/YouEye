/**
 * Suggestions API
 *
 * GET  /api/suggestions — list active suggestions
 * POST /api/suggestions — dismiss a suggestion { action: "dismiss", id }
 */

import { NextResponse } from 'next/server';
import { listSuggestions, dismissSuggestion, removeSuggestion } from '@/lib/bridges/suggestions';

export async function GET() {
  const suggestions = await listSuggestions();
  return NextResponse.json(suggestions);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { action, id } = body;

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  if (action === 'dismiss') {
    await dismissSuggestion(id);
    return NextResponse.json({ ok: true });
  }

  if (action === 'remove') {
    await removeSuggestion(id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
