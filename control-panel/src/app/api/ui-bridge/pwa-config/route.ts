/**
 * UI Bridge: PWA Config
 *
 * GET  /api/ui-bridge/pwa-config — returns PWA configuration for UI manifest
 * POST /api/ui-bridge/pwa-config — pushes PWA config to UI
 *
 * Provides theme colors, maskable icon background, and display settings
 * derived from the setup wizard configuration. The UI reads these to
 * generate its web manifest dynamically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { settingsService } from '@/lib/settings';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

let cachedToken: string | null = null;
function getBridgeToken(): string {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync("/etc/youeye/ui-bridge-token", "utf-8").trim();
    return cachedToken;
  } catch {
    return "";
  }
}

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const raw = await settingsService.getRaw();
    const siteName = (raw.site_name as string) || 'YouEye';

    // Icon config stored in extra settings
    const extra = (raw as Record<string, unknown>).extra as Record<string, unknown> | undefined;
    const iconBgColor = (extra?.icon_bg_color as string) || '#8B5CF6';

    return NextResponse.json({
      site_name: siteName,
      theme_color: '#8B5CF6',
      background_color: '#0a0a0f',
      maskable_bg_color: iconBgColor,
      display: 'standalone' as const,
      orientation: 'any' as const,
    });
  } catch (err) {
    console.error('[ui-bridge/pwa-config] Error:', err);
    return NextResponse.json(
      { error: 'Failed to load PWA config' },
      { status: 500 }
    );
  }
}

/**
 * Push PWA config to UI. Called after setup or settings changes.
 * UI stores the config and uses it for manifest generation.
 */
export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const token = getBridgeToken();
    if (!token) {
      return NextResponse.json(
        { error: 'Bridge token not available' },
        { status: 503 }
      );
    }

    const uiUrl = process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;

    const res = await fetch(`${uiUrl}/api/ui-bridge/pwa-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Bridge-Token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[ui-bridge/pwa-config] UI push failed:', text);
      return NextResponse.json({ error: 'Failed to push to UI' }, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[ui-bridge/pwa-config] Push error:', err);
    return NextResponse.json(
      { error: 'Failed to push PWA config' },
      { status: 500 }
    );
  }
}
