/**
 * SMTP Test Email API
 *
 * POST /api/settings/smtp/test — send a test email via configured SMTP
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { sendTestEmail } from '@/lib/smtp/mailer';

export async function POST() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const settings = await settingsService.getAll();

    if (!settings.smtpHost) {
      return NextResponse.json(
        { error: 'SMTP is not configured' },
        { status: 400 }
      );
    }

    const password = await readSmtpPassword();
    if (!password) {
      return NextResponse.json(
        { error: 'SMTP password not found' },
        { status: 400 }
      );
    }

    await sendTestEmail({
      host: settings.smtpHost,
      port: settings.smtpPort || 587,
      username: settings.smtpUsername || '',
      password,
      from: settings.smtpFrom || '',
      useTls: settings.smtpRequireTls ?? true,
      to: settings.smtpFrom || '', // Send test to the configured "from" address
    });

    return NextResponse.json({ success: true, message: 'Test email sent' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send test email';
    return NextResponse.json(
      { error: message, success: false },
      { status: 500 }
    );
  }
}
