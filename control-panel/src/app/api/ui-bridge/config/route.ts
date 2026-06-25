/**
 * UI Bridge: Config
 *
 * GET /api/ui-bridge/config
 * PATCH /api/ui-bridge/config — updates config, pushes language to UI
 *
 * Returns platform configuration including CP URL for the UI to link to.
 * When language is changed, pushes to YE-UI (one-way bridge: CP → UI).
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { settingsService } from '@/lib/settings';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

/** Read bridge token for calling YE-UI */
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

/**
 * Push language change to YE-UI.
 * One-way bridge: CP pushes to UI, UI stores locally.
 */
async function pushLanguageToUI(language: string): Promise<void> {
  const token = getBridgeToken();
  if (!token) {
    console.warn("[ui-bridge/config] No bridge token, skipping UI push");
    return;
  }

  const uiUrl = process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;

  try {
    const res = await fetch(`${uiUrl}/api/ui-bridge/language`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-UI-Bridge-Token": token,
      },
      body: JSON.stringify({ language }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(`[ui-bridge/config] UI language push failed: ${res.status}`);
    }
  } catch (err) {
    console.error("[ui-bridge/config] UI language push error:", err);
  }
}

/** Fields YE-UI is permitted to update via this bridge endpoint */
const ALLOWED_PATCH_FIELDS = ['language'] as const;
type AllowedPatchField = typeof ALLOWED_PATCH_FIELDS[number];

export async function PATCH(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();

    // Allowlist: only forward fields that YE-UI is permitted to change
    const allowed: Partial<Record<AllowedPatchField, unknown>> = {};
    for (const field of ALLOWED_PATCH_FIELDS) {
      if (field in body) allowed[field] = body[field];
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    await settingsService.setRaw(allowed as Record<string, unknown>);
    const updated = await settingsService.getRaw();

    // One-way bridge: push language to YE-UI so it stores locally
    if (allowed.language && typeof allowed.language === "string") {
      // Fire-and-forget — don't block response on UI push
      pushLanguageToUI(allowed.language).catch(() => {});
    }

    return NextResponse.json({ status: 'ok', config: updated });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to update config' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const config = await settingsService.getRaw();
    const domain = config.domain || '';
    const cpSubdomain = config.subdomains?.control || 'control';

    // CP is accessible at https://<cp-subdomain>.<domain>
    const cpUrl = domain ? `https://${cpSubdomain}.${domain}` : '';

    return NextResponse.json({ cpUrl, domain });
  } catch (err) {
    console.error('[UI Bridge] Config error:', err);
    return NextResponse.json(
      { error: 'Failed to read config' },
      { status: 500 }
    );
  }
}
