/**
 * UI Bridge: Auth Endpoint
 *
 * POST /api/ui-bridge/auth
 *
 * Validates the shared service token. Used by the YouEye UI to verify
 * that it has the correct token before making further requests.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';

export async function POST(request: NextRequest) {
  try {
    const authError = await validateBridgeToken(request);
    if (authError) {
      return authError;
    }

    return NextResponse.json({ valid: true });
  } catch (err) {
    console.error('[UI Bridge] Auth validation error:', err);
    return NextResponse.json(
      { valid: false, error: 'Authentication service error' },
      { status: 500 }
    );
  }
}
