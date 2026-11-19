/**
 * Versions in the Control Panel.
 *
 * Releases (YouEye, native apps, Pointer) are ordered by one rule, the same as
 * Go's `releasecache.CompareReleases`: the line `X.Y.Z` numerically, then the
 * build's `sequence` (its publish time, kept by every promotion). Release names
 * (`X.Y.Z-dev.N`, `-alpha.N`, `-beta.N`, `X.Y.Z`) are labels and never decide;
 * an old-shape document's `build` is ignored. `compareReleases` is that rule;
 * the shared vectors in releasecache/testdata/release-order.json verify Go and
 * TypeScript parity (tests/version-vectors.spec.ts).
 *
 * `compareVersions` orders other version strings (Market app manifests); for a
 * release it is only the old build rule, used for records written before
 * releases carried a sequence. The vectors in
 * spine/internal/version/testdata/vectors.json check it.
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

/** The line `X.Y.Z` of a release version (`X.Y.Z` or `X.Y.Z-label.N`); null when it is not one. */
export function releaseLine(version: string): string | null {
  const parsed = typeof version === 'string' ? parseReleaseVersion(version) : null;
  return parsed ? parsed.core.join('.') : null;
}

/** Order of two lines (`X.Y.Z`, or release versions read as their line), numerically. Throws on anything else. */
export function compareLines(a: string, b: string): number {
  const left = parseReleaseVersion(a)?.core, right = parseReleaseVersion(b)?.core;
  if (!left || !right) throw new Error(`Not a release line: ${JSON.stringify(left ? b : a)}`);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

/** What orders a release: its line and the build's sequence. */
export type ReleaseKey = { line: string; sequence: number };
/** A release document (`version`, `sequence`) or a recorded key (`line`, `sequence`). */
export type ReleaseOrderInput = { version: string; sequence: number } | ReleaseKey;

/** The key of a release document or record. Throws when it has no valid line or sequence. */
export function releaseKey(release: ReleaseOrderInput): ReleaseKey {
  const line = releaseLine('line' in release ? release.line : release.version);
  if (!line || !Number.isSafeInteger(release.sequence) || release.sequence < 1) throw new Error('Release has no valid line and sequence');
  return { line, sequence: release.sequence };
}

export function validReleaseKey(value: unknown): value is ReleaseKey {
  const key = value as Partial<ReleaseKey> | null;
  return !!key && typeof key === 'object' && typeof key.line === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(key.line)
    && Number.isSafeInteger(key.sequence) && key.sequence! >= 1;
}

/**
 * Order of two releases: the line, then the build's sequence. Names never
 * decide. 0 means the same build (whatever channel names it); the caller then
 * requires the same payload.
 */
export function compareReleases(a: ReleaseOrderInput, b: ReleaseOrderInput): number {
  const left = releaseKey(a), right = releaseKey(b);
  return compareLines(left.line, right.line) || Math.sign(left.sequence - right.sequence);
}

/**
 * Whether a release (`installed`) meets a line floor (`minimum`): a document's
 * `minimum_release` or an app's `requires.youeye`. Compared by line only; an
 * old-shape value (`0.6.5-dev.2`) is read as its line. False when either is
 * not a release version (like Go), never a throw.
 */
export function meetsMinimumRelease(installed: string, minimum: string): boolean {
  const left = releaseLine(installed), right = releaseLine(minimum);
  return !!left && !!right && compareLines(left, right) >= 0;
}

/**
 * Whether a value is a build name (`X.Y.Z-dev.N`), the only release names the
 * old build rule (`compareVersions`) may order against each other. A promoted
 * name (`-alpha.N`, `-beta.N`, `X.Y.Z`) or a line is a label.
 */
export function isBuildName(value: string | undefined): value is string {
  return typeof value === 'string' && parseReleaseVersion(value)?.token === 'dev';
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
 * Fallback for versions that are not release identities, which are parsed first.
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

  // The old build rule: the suffix token never decides, N does within a line,
  // and a version without a suffix sorts after every suffixed one of its line.
  // Releases are ordered by compareReleases instead.
  if (!left.token !== !right.token) return left.token ? -1 : 1;
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
