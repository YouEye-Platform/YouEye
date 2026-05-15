/**
 * Certificate Utilities
 *
 * PEM-to-DER conversion and deterministic UUID generation
 * for .mobileconfig profile building.
 */

import { createHash } from 'crypto';

/**
 * Convert PEM certificate to DER (binary) format.
 * Strips PEM headers/footers and decodes base64.
 */
export function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
  return Buffer.from(base64, 'base64');
}

/**
 * Generate a deterministic UUID v5-style from a name string.
 * Used for .mobileconfig PayloadUUID — prevents duplicate profiles
 * when the user re-downloads (same domain = same UUID = replacement).
 */
export function deterministicUUID(name: string): string {
  const hash = createHash('sha1')
    .update('youeye-profile-' + name)
    .digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '5' + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-').toUpperCase();
}
