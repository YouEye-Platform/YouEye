/**
 * Setup Language Endpoint
 *
 * POST /api/setup/language
 *
 * Called during setup wizard Step 0 (language selection).
 * Stores the selected language in a cookie so next-intl picks it up
 * before youeye.yaml is written (setup not yet complete).
 *
 * Also persists the choice to youeye.yaml if Spine is reachable,
 * so the wizard renders in the chosen language on reload.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withReadySetupWork } from '@/lib/setup/readiness';
import { settingsService } from '@/lib/settings';
import { cookies } from 'next/headers';
import { spineClient } from '@/lib/spine/client';

import { locales as SUPPORTED_LOCALES } from "@/i18n/config";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }
  // Onboarding must never provide an alternate path around the normal
  // authenticated personal/instance preference APIs after setup.
  try {
    if ((await spineClient.getConfig()).setup_completed === true) {
      return NextResponse.json({ error: 'Setup already completed' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Setup status is temporarily unavailable' }, { status: 503 });
  }
  try {
    const body = await request.json();
    const lang = body.language;

    if (!lang || !SUPPORTED_LOCALES.includes(lang)) {
      return NextResponse.json(
        { error: 'Invalid language code' },
        { status: 400 }
      );
    }

    // Set cookie for immediate locale resolution.
    // BUG-021: httpOnly must be false so the setup page can detect the cookie
    // on reload and skip past the language selection step.
    const cookieStore = await cookies();
    cookieStore.set('ye-setup-language', lang, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600, // 1 hour — enough for setup
    });

    // Try to persist to youeye.yaml via Spine
    try {
      if ((await getSession())?.isAdmin) {
        await withReadySetupWork(() => settingsService.setRaw({ language: lang }));
      }
    } catch {
      // Spine not reachable during early setup — cookie is enough
    }

    return NextResponse.json({ ok: true, language: lang });
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
}
