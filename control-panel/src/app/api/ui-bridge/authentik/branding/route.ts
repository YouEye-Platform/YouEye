/**
 * Authentik Branding Bridge Endpoint
 *
 * POST /api/ui-bridge/authentik/branding
 *
 * Receives theme CSS from YouEye UI and pushes it to Authentik's
 * default brand as custom CSS. Also generates a WordArt SVG logo
 * and updates authentication flow titles.
 *
 * Auth: same-origin embed requests only (Referer from /embed/)
 */

import { NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { syncBrandingToAuthentik } from '@/lib/authentik/sync-branding';

export async function POST(request: Request) {
  // Validate embed origin
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { css, siteName, siteNameStyle, fontSlug } = body as {
      css?: string;
      siteName?: string;
      siteNameStyle?: Record<string, unknown>;
      fontSlug?: string;
    };

    if (!css) {
      return NextResponse.json(
        { error: 'css field is required' },
        { status: 400 }
      );
    }

    const result = await syncBrandingToAuthentik({ css, siteName, siteNameStyle, fontSlug });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Failed to sync branding' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[authentik-branding] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to update Authentik branding',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
