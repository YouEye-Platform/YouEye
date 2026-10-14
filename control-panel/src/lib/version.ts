/**
 * Canonical X.Y.Z[-token.N] release identities plus retained numeric versions.
 * Source/channel authority is selected before comparison. The shared vectors
 * in spine/internal/version/testdata/vectors.json verify Go/TypeScript parity.
 */

/** Canonical release identity. Source/channel policy is checked before ordering. */
export type ReleaseVersion = { core: [number, number, number]; token: string; counter: number };
export function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$/.exec(value);
  if (!match || (match[4]?.length ?? 0) > 63) return null;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[5] ?? 0)];
  if (!numbers.every(Number.isSafeInteger)) return null;
  return { core: [numbers[0], numbers[1], numbers[2]], token: match[4] ?? '', counter: numbers[3] };
}

function comparisonParts(value: string): { core: number[]; token: string; counter: number } {
  const raw = value.startsWith('v') ? value.slice(1) : value;
  return parseReleaseVersion(raw) ?? { core: splitVersion(raw), token: '', counter: 0 };
}

/** Maximum number of dot-separated segments a valid version may have. */
export const MAX_VERSION_SEGMENTS = 10;

/**
 * Split a version string into numeric segments.
 * Strips a leading "v" if present.
 * Legacy-only helper; canonical release identities are parsed first.
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
 * Compares each segment numerically. Missing segments are treated as 0
 * (e.g., "1.2.3" == "1.2.3.0", "0.5.6" == "0.5.6.0.0").
 */
export function compareVersions(a: string, b: string): number {
  const left = comparisonParts(a);
  const right = comparisonParts(b);
  const aParts = left.core;
  const bParts = right.core;
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const aVal = i < aParts.length ? aParts[i] : 0;
    const bVal = i < bParts.length ? bParts[i] : 0;

    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }

  if (left.token !== right.token) {
    if (!left.token) return 1;
    if (!right.token) return -1;
    return left.token < right.token ? -1 : 1;
  }
  return Math.sign(left.counter - right.counter);
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

/**
 * Parse numeric core segments for validation. Canonical prerelease suffixes
 * are validated but callers must retain the original string for ordering.
 *
 * Accepts an optional leading "v", then 1–10 dot-separated segments where every
 * segment is a non-empty run of ASCII digits. Returns the parsed numbers, or
 * null if the string is not a well-formed version (empty, empty segment,
 * non-numeric segment, or more than MAX_VERSION_SEGMENTS segments).
 *
 * Note: leading zeros are permitted ("01.2.3" -> [1, 2, 3]).
 */
export function parseVersionStrict(v: string): number[] | null {
  if (typeof v !== 'string') return null;
  const stripped = v.startsWith('v') ? v.slice(1) : v;
  if (stripped === '') return null;
  const release = parseReleaseVersion(stripped);
  if (release) return [...release.core];

  const parts = stripped.split('.');
  if (parts.length < 1 || parts.length > MAX_VERSION_SEGMENTS) return null;

  const out: number[] = [];
  for (const p of parts) {
    if (p === '' || !/^[0-9]+$/.test(p)) return null;
    out.push(parseInt(p, 10));
  }
  return out;
}

/**
 * Trim trailing zero segments from a parsed version, keeping a minimum count.
 */
function trimSegments(parts: number[], minSegments: number): number[] {
  let end = parts.length;
  while (end > minSegments && parts[end - 1] === 0) {
    end--;
  }
  return parts.slice(0, end);
}

/**
 * Format a version for DISPLAY / CLI output / release titles.
 *
 * Strips a leading "v", trims trailing zero segments, and always keeps at least
 * one segment. Examples:
 *   "0.5.0.0.0.0.0.0.0" -> "0.5"
 *   "2.0.0"             -> "2"
 *   "0.5.6.0.0.1.0.0.0" -> "0.5.6.0.0.1"
 *   "0"                 -> "0"
 *   "v0.5.10"           -> "0.5.10"
 *
 * Canonical three-part release identities retain all positions and suffixes.
 * Historical numeric input retains its previous formatting rules.
 */
export function formatVersion(v: string): string {
  const raw = v.startsWith('v') ? v.slice(1) : v;
  if (parseReleaseVersion(raw)) return raw;
  const parts = splitVersion(v);
  return trimSegments(parts, 1).join('.');
}

/**
 * Format a version for a release TAG.
 *
 * Like formatVersion but keeps a minimum of 3 segments so that old/straggler
 * boxes that still parse plain "x.y.z" stable tags keep working forever.
 * Examples:
 *   "0.6.0"    -> "0.6.0"   (display would be "0.6")
 *   "2"        -> "2.0.0"
 *   "0.5.11.1" -> "0.5.11.1"
 *   "0"        -> "0.0.0"
 */
export function formatVersionTag(v: string): string {
  const raw = v.startsWith('v') ? v.slice(1) : v;
  if (parseReleaseVersion(raw)) return raw;
  const parts = splitVersion(v);
  const trimmed = trimSegments(parts, 3);
  while (trimmed.length < 3) trimmed.push(0);
  return trimmed.join('.');
}
