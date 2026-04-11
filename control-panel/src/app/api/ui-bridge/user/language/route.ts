/**
 * UI Bridge: User Language Change
 *
 * PATCH /api/ui-bridge/user/language
 *
 * Called by YE-UI when a user changes their language in settings.
 * Triggers the full language propagation pipeline:
 *   1. Update youeye.yaml system language
 *   2. Sync Authentik user locale
 *   3. Update language env vars on all app containers
 *
 * The response returns immediately with the count of apps being updated.
 * App container restarts happen asynchronously in the background.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { propagateLanguageToAll, getLanguageSupportedAppCount } from '@/lib/language/service';

const SUPPORTED_LOCALES = ['en', 'ru', 'es', 'de', 'fr'];

export async function PATCH(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { locale, userId, authentikUserId } = body;

    if (!locale || !SUPPORTED_LOCALES.includes(locale)) {
      return NextResponse.json(
        { error: 'Invalid locale. Supported: ' + SUPPORTED_LOCALES.join(', ') },
        { status: 400 }
      );
    }

    // Get app count for immediate response
    const appCount = await getLanguageSupportedAppCount();

    // Start propagation (runs sequentially but we respond immediately
    // for the system + authentik parts, then apps continue in background)
    const resultPromise = propagateLanguageToAll(
      locale,
      authentikUserId ? Number(authentikUserId) : undefined
    );

    // Wait briefly for system + authentik (fast operations)
    // Then respond while apps continue updating
    const result = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    if (result) {
      // All done within 5s
      return NextResponse.json({
        ok: true,
        locale,
        systemUpdated: result.systemUpdated,
        authentikUpdated: result.authentikUpdated,
        appsUpdated: result.appsUpdated,
        appsFailed: result.appsFailed,
        propagatingToApps: 0,
      });
    }

    // Still propagating to apps — respond with count
    return NextResponse.json({
      ok: true,
      locale,
      systemUpdated: true,
      propagatingToApps: appCount,
      message: `Language updated. Propagating to ${appCount} apps in the background.`,
    });
  } catch (err) {
    console.error('[UI Bridge] Language change error:', err);
    return NextResponse.json(
      { error: 'Failed to propagate language change' },
      { status: 500 }
    );
  }
}
