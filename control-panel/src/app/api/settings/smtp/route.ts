/**
 * SMTP Settings API
 *
 * GET  /api/settings/smtp — return current SMTP configuration (admin only)
 * POST /api/settings/smtp — save SMTP configuration (admin only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { settingsService } from '@/lib/settings';
import { readSmtpPassword, writeSmtpPassword } from '@/lib/smtp/secrets';
import { configureAuthentikSmtp } from '@/lib/smtp/authentik-sync';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const settings = await settingsService.getAll();
    const hasPassword = await readSmtpPassword() !== '';

    return NextResponse.json({
      configured: !!settings.smtpHost,
      host: settings.smtpHost || '',
      port: settings.smtpPort || 587,
      username: settings.smtpUsername || '',
      from: settings.smtpFrom || '',
      requireTls: settings.smtpRequireTls ?? true,
      hasPassword,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read SMTP settings' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { host, port, username, password, from, requireTls } = body;

    if (!host || !port || !username || !from) {
      return NextResponse.json(
        { error: 'Missing required fields: host, port, username, from' },
        { status: 400 }
      );
    }

    // Store non-sensitive config in youeye.yaml
    await settingsService.set({
      smtpHost: host,
      smtpPort: Number(port),
      smtpUsername: username,
      smtpFrom: from,
      smtpRequireTls: requireTls ?? true,
    });

    // Store password securely on disk
    if (password) {
      await writeSmtpPassword(password);
    }

    // Sync SMTP config to Authentik (best-effort)
    try {
      const smtpPassword = password || await readSmtpPassword();
      await configureAuthentikSmtp({
        host,
        port: Number(port),
        username,
        password: smtpPassword,
        from,
        useTls: requireTls ?? true,
      });
    } catch (err) {
      console.error('[SMTP] Authentik sync failed (non-blocking):', err);
    }

    return NextResponse.json({
      success: true,
      configured: true,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save SMTP settings' },
      { status: 500 }
    );
  }
}
