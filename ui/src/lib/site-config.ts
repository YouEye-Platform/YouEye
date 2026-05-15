/**
 * Site Config Helper
 *
 * Reads site_name from the system_settings table.
 * Falls back to 'YouEye' if not set.
 */

import { db } from '@/db';
import { systemSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

const DEFAULT_SITE_NAME = 'YouEye';

export async function getSiteName(): Promise<string> {
  try {
    const row = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'site_name'))
      .limit(1);
    
    if (row.length > 0 && typeof row[0].value === 'string') {
      return row[0].value;
    }
    return DEFAULT_SITE_NAME;
  } catch {
    return DEFAULT_SITE_NAME;
  }
}
