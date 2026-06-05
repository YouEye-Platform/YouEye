/**
 * User Language Sync API
 *
 * PATCH /api/user/language — Propagate language to system/app settings
 *
 * Dashboard-compatible alternative to /api/ui-bridge/user/language (which
 * requires bridge token + embed Referer). Uses session auth instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { propagateLanguageToAll } from '@/lib/language/service';

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { locale?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const locale = body.locale?.trim();
  if (!locale) {
    return NextResponse.json({ error: 'locale is required' }, { status: 400 });
  }

  // Propagate: system + apps. YouEye ID does not store per-user language in
  // Authentik attributes; the UI profile path persists user-facing language.
  const result = await propagateLanguageToAll(locale);

  return NextResponse.json({
    success: true,
    systemUpdated: result.systemUpdated,
    authentikUpdated: result.authentikUpdated,
    appsUpdated: result.appsUpdated,
    appsFailed: result.appsFailed,
  });
}
