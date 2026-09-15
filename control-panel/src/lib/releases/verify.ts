import { createHash, createPublicKey, verify } from 'crypto';

export const RELEASE_DEVELOPMENT_TRUST = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAha3Qt2DxI8tDarUb24mmRRekCa1acvk/ttqyJ14y1OE=
-----END PUBLIC KEY-----
`;

const MAX_METADATA_BYTES = 1024 * 1024;

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fetchBounded(url: URL, expectedSize?: number): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'User-Agent': 'youeye-control' } });
  if (!response.ok) throw new Error(`Signed release metadata returned HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length === 0 || raw.length > MAX_METADATA_BYTES || (expectedSize !== undefined && raw.length !== expectedSize)) {
    throw new Error('Signed release metadata is empty, oversized, or has the wrong size');
  }
  return raw;
}

export async function verifySignedReleaseArtifactBuffer(
  artifactURL: string,
  artifact: Buffer,
  artifactName = 'standalone.tar',
  expectedDigest?: string,
): Promise<string> {
  const base = new URL('./', artifactURL);
  const [publishedTrust, checksums, signature] = await Promise.all([
    fetchBounded(new URL('release-development.pub', base)),
    fetchBounded(new URL('SHA256SUMS', base)),
    fetchBounded(new URL('SHA256SUMS.sig', base), 64),
  ]);
  if (!publishedTrust.equals(Buffer.from(RELEASE_DEVELOPMENT_TRUST))) {
    throw new Error('Published release trust anchor does not match the embedded identity');
  }
  if (!verify(null, checksums, createPublicKey(RELEASE_DEVELOPMENT_TRUST), signature)) {
    throw new Error('Release checksum signature is invalid');
  }
  const entries = new Map<string, string>();
  for (const line of checksums.toString('utf8').trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Signed release checksum document is malformed');
    entries.set(match[2], match[1]);
  }
  if (entries.size !== 4 || !entries.has(artifactName) || !entries.has('release-development.pub') || !entries.has('provenance.json') || !entries.has('sbom.spdx.json')) {
    throw new Error('Signed release checksum set is incomplete');
  }
  if (entries.get('release-development.pub') !== sha256(publishedTrust)) {
    throw new Error('Published release trust anchor digest is not signed');
  }
  const digest = sha256(artifact);
  if (entries.get(artifactName) !== digest) throw new Error('Release artifact does not match the signed checksum');
  if (expectedDigest && expectedDigest.toLowerCase() !== digest) throw new Error('Release artifact does not match the exact configured channel digest');
  return digest;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function signedReleaseVerificationShell(artifactURL: string, artifactPath: string, expectedDigest?: string): string {
  const base = new URL('./', artifactURL).toString();
  const encodedTrust = Buffer.from(RELEASE_DEVELOPMENT_TRUST).toString('base64');
  const expected = expectedDigest?.toLowerCase() ?? '';
  return `
set -eu
verify_dir=$(mktemp -d /tmp/youeye-release-verify.XXXXXX)
trap 'rm -rf -- "$verify_dir"' EXIT
printf %s ${shellQuote(encodedTrust)} | base64 -d >"$verify_dir/embedded.pub"
curl -fsSL ${shellQuote(new URL('release-development.pub', base).toString())} -o "$verify_dir/published.pub"
curl -fsSL ${shellQuote(new URL('SHA256SUMS', base).toString())} -o "$verify_dir/SHA256SUMS"
curl -fsSL ${shellQuote(new URL('SHA256SUMS.sig', base).toString())} -o "$verify_dir/SHA256SUMS.sig"
cmp -s "$verify_dir/embedded.pub" "$verify_dir/published.pub"
test "$(stat -c %s "$verify_dir/SHA256SUMS.sig")" = 64
openssl pkeyutl -verify -pubin -inkey "$verify_dir/embedded.pub" -rawin -in "$verify_dir/SHA256SUMS" -sigfile "$verify_dir/SHA256SUMS.sig" >/dev/null
test "$(wc -l < "$verify_dir/SHA256SUMS")" = 4
for required in standalone.tar release-development.pub provenance.json sbom.spdx.json; do test "$(awk -v name="$required" '$2==name {count++} END {print count+0}' "$verify_dir/SHA256SUMS")" = 1; done
signed=$(awk '$2=="standalone.tar" {print $1}' "$verify_dir/SHA256SUMS")
test "$(sha256sum ${shellQuote(artifactPath)} | awk '{print $1}')" = "$signed"
test -z ${shellQuote(expected)} || test "$signed" = ${shellQuote(expected)}
test "$(sha256sum "$verify_dir/published.pub" | awk '{print $1}')" = "$(awk '$2=="release-development.pub" {print $1}' "$verify_dir/SHA256SUMS")"
rm -rf -- "$verify_dir"
trap - EXIT
`;
}
