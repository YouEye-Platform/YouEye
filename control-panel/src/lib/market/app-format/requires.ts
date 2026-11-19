/** `requires.youeye: ">=X.Y.Z"` against the box's installed release (its line X.Y.Z; labels never decide). */
import { meetsMinimumRelease, releaseLine } from '../../version';

/** The minimum version of a `>=X.Y.Z` requirement. */
export function minimumYouEye(requirement: string): string {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(requirement);
  if (!match) throw new Error(`Unsupported requires.youeye "${requirement}"`);
  return match[1];
}

/** Null when `platformVersion` (the installed release's version) satisfies the app's requirement, else a message for the owner. */
export function youeyeRequirementProblem(requires: { youeye: string } | undefined, platformVersion: string): string | null {
  if (!requires) return null;
  const minimum = minimumYouEye(requires.youeye);
  if (meetsMinimumRelease(platformVersion, minimum)) return null;
  return `This app needs YouEye ≥ ${minimum}; this box runs ${releaseLine(platformVersion) ? platformVersion : 'an unknown version'}.`;
}
