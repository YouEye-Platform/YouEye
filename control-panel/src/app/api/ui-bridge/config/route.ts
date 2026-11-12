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
import { requireEmbedAdmin } from '@/lib/ui-bridge/auth';
import { settingsService } from '@/lib/settings';
import { pushLanguageToUI } from "@/lib/language/bridge";

/** Fields YE-UI is permitted to update via this bridge endpoint */
const ALLOWED_PATCH_FIELDS = ['language'] as const;
type AllowedPatchField = typeof ALLOWED_PATCH_FIELDS[number];

export async function PATCH(request: NextRequest) {
  const authError = await requireEmbedAdmin(request);
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
      await pushLanguageToUI(allowed.language);
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
  const authError = await requireEmbedAdmin(request);
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
