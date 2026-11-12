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
import { settingsService } from "@/lib/settings";
import { pushLanguageToUI } from "@/lib/language/bridge";
import { locales } from "@/i18n/config";

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (!session.isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  let body: { locale?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const locale = typeof body.locale === "string" ? body.locale.trim() : null;
  if (!locale || !locales.includes(locale)) {
    return NextResponse.json({ error: 'locale is required' }, { status: 400 });
  }

  let systemUpdated = false;
  try {
    await settingsService.set({ language: locale });
    systemUpdated = true;
    // Native apps read personal/instance locale from the authenticated header.
    // A language change does not require restarting their containers.
    await pushLanguageToUI(locale);
    return NextResponse.json({ success: true, systemUpdated, language: locale });
  } catch {
    return NextResponse.json({ error: "Language propagation failed", systemUpdated }, { status: 502 });
  }
}
