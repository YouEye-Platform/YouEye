/**
 * HMAC-SHA256 Request Signing & Verification
 *
 * Apps sign inter-app requests using APP_SECRET (generated at install time).
 * YE-UI verifies the signature using constant-time comparison.
 *
 * Headers:
 *   X-App-Slug: <app-slug>
 *   X-App-Signature: <hmac-sha256 of request body>
 *
 * During grace period (require_app_signatures: false), requests without
 * signatures are accepted with a warning log.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { db, ensureSchema } from '@/db';
import { systemSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

// ─── Types ──────────────────────────────────────────────

export interface HmacVerifyResult {
  valid: boolean;
  appSlug: string | null;
  reason?: string;
}

// ─── HMAC Computation ───────────────────────────────────

/**
 * Compute HMAC-SHA256 of the given body using the app's secret.
 */
export function computeHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time comparison of two HMAC strings.
 * CRITICAL: Never use === for HMAC comparison.
 */
export function verifyHmac(
  provided: string,
  expected: string
): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(provided, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// ─── Feature Flag ───────────────────────────────────────

/**
 * Check if app signature verification is required.
 * Default: false (grace period for existing apps).
 */
export async function isSignatureRequired(): Promise<boolean> {
  try {
    await ensureSchema();
    const [row] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'require_app_signatures'))
      .limit(1);

    if (!row) return false;
    return row.value === true;
  } catch {
    return false;
  }
}

// ─── App Secret Lookup ──────────────────────────────────

/**
 * Get APP_SECRET for a given app slug from the secrets system.
 * The secret is stored in systemSettings under `app_secret:<slug>`.
 */
export async function getAppSecret(appSlug: string): Promise<string | null> {
  try {
    await ensureSchema();
    const [row] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, `app_secret:${appSlug}`))
      .limit(1);

    if (!row) return null;
    return typeof row.value === 'string' ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * Store an APP_SECRET for an app slug.
 */
export async function storeAppSecret(
  appSlug: string,
  secret: string
): Promise<void> {
  await ensureSchema();
  const key = `app_secret:${appSlug}`;

  // Upsert
  const [existing] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);

  if (existing) {
    await db
      .update(systemSettings)
      .set({ value: secret, updatedAt: new Date() })
      .where(eq(systemSettings.key, key));
  } else {
    await db.insert(systemSettings).values({ key, value: secret });
  }
}

/**
 * Generate a cryptographically secure app secret.
 */
export function generateAppSecret(): string {
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return randomBytes(32).toString('hex');
}
