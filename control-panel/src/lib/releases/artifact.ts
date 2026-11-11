import { createHash } from 'node:crypto';
import { coreArtifactVerificationShell, selectedCoreArtifact, verifyCoreArtifactBuffer, type CoreRole } from './core-release';

/**
 * Release artifacts are bound by SHA-256 only. A member of the accepted System
 * release is checked by digest and size against that member; any other
 * artifact is checked against its pinned channel digest when one is
 * configured, and otherwise relies on HTTPS transport alone.
 */
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const pinned = (digest?: string) => {
  const value = digest?.toLowerCase();
  if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) throw new Error('Pinned release digest is malformed');
  return value;
};

export function verifyReleaseArtifactBuffer(artifactURL: string, artifact: Buffer, expectedDigest?: string, role?: CoreRole): string {
  const core = selectedCoreArtifact(artifactURL, expectedDigest, role);
  if (core) return verifyCoreArtifactBuffer(core, artifact);
  const digest = createHash('sha256').update(artifact).digest('hex'), expected = pinned(expectedDigest);
  if (!artifact.length) throw new Error('Release artifact is empty');
  if (expected && expected !== digest) throw new Error('Release artifact does not match the exact configured channel digest');
  return digest;
}

/** Shell run inside the target container after the selected artifact was downloaded. */
export function releaseArtifactVerificationShell(artifactURL: string, artifactPath: string, expectedDigest?: string, role?: CoreRole): string {
  const core = selectedCoreArtifact(artifactURL, expectedDigest, role);
  if (core) return coreArtifactVerificationShell(core, artifactPath);
  const expected = pinned(expectedDigest);
  return `
set -eu
test -s ${quote(artifactPath)}
${expected ? `test "$(sha256sum ${quote(artifactPath)} | awk '{print $1}')" = ${quote(expected)}` : ''}
`;
}
