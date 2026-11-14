import { NextResponse } from 'next/server';
import { SpineAPIError } from '@/lib/spine/client';

/** A Spine refusal keeps its status and message (never a password); anything else is a 503. */
export function consoleRouteError(error: unknown) {
  if (error instanceof SpineAPIError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
  }
  console.error('[console-access] Spine request failed:', error instanceof Error ? error.message : 'unknown error');
  return NextResponse.json({ error: 'Console access is unavailable.' }, { status: 503 });
}
