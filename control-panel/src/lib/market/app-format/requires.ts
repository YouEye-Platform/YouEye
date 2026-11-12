/** `requires.youeye: ">=X.Y.Z"` against the box's YouEye build (X.Y.Z of X.Y.Z[-dev.N|-alpha.N|-rc.N]). */

type Triple = [number, number, number];

function triple(version: string): Triple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Triple, b: Triple): number {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** The minimum version of a `>=X.Y.Z` requirement. */
export function minimumYouEye(requirement: string): string {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(requirement);
  if (!match) throw new Error(`Unsupported requires.youeye "${requirement}"`);
  return match[1];
}

/** Null when `platformVersion` satisfies the app's requirement, else a message for the owner. */
export function youeyeRequirementProblem(requires: { youeye: string } | undefined, platformVersion: string): string | null {
  if (!requires) return null;
  const minimum = minimumYouEye(requires.youeye);
  const installed = triple(platformVersion);
  if (installed && compare(installed, triple(minimum)!) >= 0) return null;
  return `This app needs YouEye ≥ ${minimum}; this box runs ${installed ? platformVersion : 'an unknown version'}.`;
}
