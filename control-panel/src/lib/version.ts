/**
 * Semantic version comparison for YouEye.
 *
 * Handles both 3-digit (x.y.z) and 4-digit (x.y.z.w) version strings,
 * comparing each segment numerically rather than lexicographically.
 */

/**
 * Split a version string into numeric segments.
 * Strips a leading "v" if present.
 * Non-numeric segments are treated as 0.
 */
function splitVersion(v: string): number[] {
  const stripped = v.startsWith('v') ? v.slice(1) : v;
  if (stripped === '') return [0];
  return stripped.split('.').map((s) => {
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  });
}

/**
 * Compare two version strings semantically.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 *
 * Supports both 3-digit (x.y.z) and 4-digit (x.y.z.w) versions.
 * Missing segments are treated as 0 (e.g., "1.2.3" == "1.2.3.0").
 */
export function compareVersions(a: string, b: string): number {
  const aParts = splitVersion(a);
  const bParts = splitVersion(b);
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const aVal = i < aParts.length ? aParts[i] : 0;
    const bVal = i < bParts.length ? bParts[i] : 0;

    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }

  return 0;
}

/**
 * Returns true if candidate is a newer version than current.
 */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Sort an array of version strings in descending order (newest first).
 * Returns a new array (does not mutate the input).
 */
export function sortVersionsDesc(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}
