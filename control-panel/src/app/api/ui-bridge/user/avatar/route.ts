/**
 * UI Bridge — Avatar Sync to Authentik
 *
 * POST /api/ui-bridge/user/avatar — receives avatar from YE-UI, forwards to Authentik
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const formData = await request.formData();
    const authentikId = formData.get('authentikId') as string;
    const file = formData.get('file') as File | null;

    if (!authentikId || !file) {
      return NextResponse.json(
        { error: 'Missing authentikId or file' },
        { status: 400 }
      );
    }

    // Get Authentik credentials
    const creds = await spineClient.getAuthentikCredentials();
    const ip = await getContainerIP('youeye-authentik');
    const authentikUrl = ip ? `http://${ip}:9000` : creds.internal_url;

    // Upload avatar to Authentik
    const avatarFormData = new FormData();
    avatarFormData.append('file', file, 'avatar.webp');

    const res = await fetch(
      `${authentikUrl}/api/v3/core/users/${authentikId}/set_avatar/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.bootstrap_token}`,
        },
        body: avatarFormData,
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { error: `Authentik API error: ${res.status} ${text}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Avatar sync failed' },
      { status: 500 }
    );
  }
}
