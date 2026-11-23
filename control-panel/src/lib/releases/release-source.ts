/**
 * The repository a box follows, as the Settings form sees it. Spine decides
 * (systemupdate.SetReleaseSource: canonical URL, one read of the target's
 * channel index); these helpers only shape the form.
 */

/** The public YouEye repository: the only one the product offers. No other host is suggested. */
export const OFFICIAL_RELEASE_REPOSITORY = 'https://github.com/YouEye-Platform/YouEye';

const REPOSITORY = /^https:\/\/([^\s/?#@:]+(?::\d+)?)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*?)(?:\.git)?\/?$/;

/** The canonical https://host/owner/repository form, or null when value is not one (Spine's CanonicalRepository decides). */
export function repositoryAddress(value: string): string | null {
  const match = REPOSITORY.exec(value.trim());
  if (!match || match[2].endsWith('.') || match[3].endsWith('.')) return null;
  return `https://${match[1].toLowerCase()}/${match[2]}/${match[3]}`;
}

/** Whether value names the repository the box already follows (so only the channel would change). */
export function isSameRepository(value: string, current: string): boolean {
  const address = repositoryAddress(value);
  return address !== null && address === repositoryAddress(current);
}
