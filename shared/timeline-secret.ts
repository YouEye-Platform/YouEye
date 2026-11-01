/** Exact existing PBKDF input: UTF-8, no trimming, case folding or normalization.
 * Length uses UTF-16 code units for compatibility with the original PIN reader.
 * Reject lone surrogates rather than silently replacing distinct inputs with U+FFFD.
 */
export const TIMELINE_SECRET_MIN = 4;
export const TIMELINE_SECRET_MAX = 1024;
export function validTimelineSecret(value: unknown): value is string {
  if (typeof value !== "string" || value.length < TIMELINE_SECRET_MIN || value.length > TIMELINE_SECRET_MAX) return false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export const TIMELINE_SECRET_HELP = "Use at least 4 characters. Letters, numbers, spaces and symbols are welcome. Keep it somewhere safe: we cannot recover it for you.";
