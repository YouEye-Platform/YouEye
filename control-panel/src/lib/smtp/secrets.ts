/**
 * SMTP Password Storage
 *
 * Stores the SMTP password in a separate file with restricted permissions.
 * Never stored in youeye.yaml (which is readable config).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';

const SMTP_PASSWORD_PATH = '/var/lib/youeye/control/.secret_smtp_password';

/**
 * Read the SMTP password from the secrets file.
 * Returns empty string if not configured.
 */
export async function readSmtpPassword(): Promise<string> {
  try {
    const content = await readFile(SMTP_PASSWORD_PATH, 'utf-8');
    return content.trim();
  } catch {
    return '';
  }
}

/**
 * Write the SMTP password to the secrets file with restricted permissions.
 */
export async function writeSmtpPassword(password: string): Promise<void> {
  await mkdir('/var/lib/youeye/control', { recursive: true });
  await writeFile(SMTP_PASSWORD_PATH, password, { mode: 0o600 });
}
