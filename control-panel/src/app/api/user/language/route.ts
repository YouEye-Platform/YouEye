/**
 * User Language Sync API
 *
 * PATCH /api/user/language — Propagate language to Authentik user profile + apps
 *
 * Dashboard-compatible alternative to /api/ui-bridge/user/language (which
 * requires bridge token + embed Referer). Uses session auth instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listUsers } from '@/lib/authentik/client';
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

  // Find the Authentik user to get their PK for locale sync
  let authentikUserId: number | undefined;
  try {
    const users = await listUsers();
    const user = users.find(
      (u) => u.username?.toLowerCase() === session.username?.toLowerCase()
    );
    if (user) {
      authentikUserId = user.pk;
    }
  } catch {
    // Authentik may be unreachable — continue without user-level sync
  }

  // Propagate: system + authentik user + apps (non-blocking for apps)
  const result = await propagateLanguageToAll(locale, authentikUserId);

  return NextResponse.json({
    success: true,
    systemUpdated: result.systemUpdated,
    authentikUpdated: result.authentikUpdated,
    appsUpdated: result.appsUpdated,
    appsFailed: result.appsFailed,
  });
}
