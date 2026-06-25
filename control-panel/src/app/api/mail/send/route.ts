/**
 * SMTP Proxy Endpoint — POST /api/mail/send
 *
 * Platform-level mail relay. Apps POST here instead of holding raw SMTP
 * credentials. The CP sends the email using current SMTP settings, so
 * changes to SMTP config are transparent — no app restart needed.
 *
 * Auth: X-App-Slug (Incus internal trust boundary) or X-UI-Bridge-Token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { sendEmail } from '@/lib/smtp/mailer';

function validateAuth(request: NextRequest): { appId: string } | null {
  // Bridge token auth (CP internal or system calls)
  const bridgeToken = request.headers.get('X-UI-Bridge-Token');
  if (bridgeToken) {
    try {
      const fs = require('fs');
      const expected = fs.readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
      if (bridgeToken === expected) {
        return { appId: 'system' };
      }
    } catch { /* token file not available */ }
  }

  // App-slug auth (Incus internal network)
  const appSlug = request.headers.get('X-App-Slug') ?? request.headers.get('x-app-slug');
  if (appSlug) {
    return { appId: appSlug };
  }

  // Market app auth via app ID header
  const marketAppId = request.headers.get('X-YouEye-App');
  if (marketAppId) {
    return { appId: marketAppId };
  }

  return null;
}

export async function POST(request: NextRequest) {
  const auth = validateAuth(request);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { to: string; subject: string; html?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.to || !body.subject) {
    return NextResponse.json(
      { error: 'Missing required fields: to, subject' },
      { status: 400 }
    );
  }

  if (!body.html && !body.text) {
    return NextResponse.json(
      { error: 'Must provide html or text body' },
      { status: 400 }
    );
  }

  // Read CURRENT SMTP settings (not cached from install time)
  const settings = await settingsService.getAll();
  const smtpPassword = await readSmtpPassword();

  if (!settings.smtpHost || !smtpPassword) {
    return NextResponse.json(
      { error: 'SMTP not configured', configured: false },
      { status: 503 }
    );
  }

  try {
    await sendEmail({
      host: settings.smtpHost,
      port: settings.smtpPort || 587,
      username: settings.smtpUsername || '',
      password: smtpPassword,
      from: settings.smtpFrom || `YouEye <noreply@${settings.domain}>`,
      useTls: settings.smtpRequireTls ?? true,
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[Mail Proxy] Send failed for app=${auth.appId}:`, err);
    return NextResponse.json(
      { error: 'Failed to send email', detail: String(err) },
      { status: 500 }
    );
  }
}
