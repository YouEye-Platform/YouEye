/**
 * Icon Upload Bridge — proxies icon blob uploads from CP embed to UI.
 *
 * POST /api/ui/branding/icon
 *
 * Accepts multipart form data (icon_config + icon_blob) and forwards to UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

const TOKEN_FILE_PATH = '/etc/youeye/ui-bridge-token';
const UI_BASE = `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;

let cachedToken: string | null = null;

function getBridgeToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
    return cachedToken;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const token = getBridgeToken();
  if (!token) {
    return NextResponse.json({ error: 'Bridge token unavailable' }, { status: 500 });
  }

  try {
    const formData = await request.formData();

    // Forward multipart to UI's icon endpoint via bridge
    const res = await fetch(`${UI_BASE}/api/ui-bridge/branding/icon`, {
      method: 'POST',
      headers: { 'X-UI-Bridge-Token': token },
      body: formData,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'UI bridge error' }, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'UI unreachable' }, { status: 502 });
  }
}
