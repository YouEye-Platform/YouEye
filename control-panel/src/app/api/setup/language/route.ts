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
import { cookies } from 'next/headers';

const SUPPORTED_LOCALES = ['en', 'ru', 'es', 'de', 'fr'];

export async function POST(request: NextRequest) {
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
      const http = await import('http');
      await new Promise<void>((resolve) => {
        const payload = JSON.stringify({ language: lang });
        const req = http.request(
          {
            socketPath: '/var/run/youeye/youeye.sock',
            path: '/api/config',
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          }
        );
        req.on('error', () => resolve());
        req.setTimeout(3000, () => {
          req.destroy();
          resolve();
        });
        req.write(payload);
        req.end();
      });
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
