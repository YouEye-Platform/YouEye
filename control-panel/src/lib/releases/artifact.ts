import { createHash } from 'node:crypto';

/**
 * Release artifacts are bound by SHA-256 (and size, when the release document
 * names it). The caller supplies the exact expectation from the accepted
 * release document; there is no URL-derived trust.
 */
export type ExpectedArtifact = { sha256: string; size_bytes?: number };
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
function exact(expected?: ExpectedArtifact): ExpectedArtifact | undefined {
  if (!expected) return undefined;
  const sha256 = expected.sha256?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256) || expected.size_bytes !== undefined && (!Number.isSafeInteger(expected.size_bytes) || expected.size_bytes <= 0)) {
    throw new Error('Expected release digest is malformed');
  }
  return { sha256, size_bytes: expected.size_bytes };
}

export function verifyReleaseArtifactBuffer(artifact: Buffer, expected?: ExpectedArtifact): string {
  const pinned = exact(expected);
  const digest = createHash('sha256').update(artifact).digest('hex');
  if (!artifact.length) throw new Error('Release artifact is empty');
  if (pinned && (pinned.sha256 !== digest || pinned.size_bytes !== undefined && pinned.size_bytes !== artifact.length)) {
    throw new Error('Release artifact differs from its release document digest');
  }
  return digest;
}

/** Shell run inside the target container after the selected artifact was downloaded. */
export function releaseArtifactVerificationShell(artifactPath: string, expected?: ExpectedArtifact): string {
  const pinned = exact(expected);
  return `
set -eu
test -s ${quote(artifactPath)}
${pinned?.size_bytes !== undefined ? `test "$(stat -c %s ${quote(artifactPath)})" = ${quote(String(pinned.size_bytes))}` : ''}
${pinned ? `test "$(sha256sum ${quote(artifactPath)} | awk '{print $1}')" = ${quote(pinned.sha256)}` : ''}
`;
}

/** Plain HTTPS download of one release asset inside a container. Never an API call. */
export function releaseDownloadShell(url: string, destination: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/\/releases\/download\//.test(parsed.pathname)) throw new Error('Release downloads must be HTTPS release assets');
  return `curl --max-time 300 --max-redirs 5 --proto '=https' --proto-redir '=https' -fsSL ${quote(url)} -o ${quote(destination)}`;
}
