import { cachedReleaseBytes } from './cache';
import publicTrustPolicy from '../../../../spine/internal/systemupdate/public-release-trust.json';
import { createHash, createPublicKey, verify } from 'crypto';

export const RELEASE_DEVELOPMENT_TRUST = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAha3Qt2DxI8tDarUb24mmRRekCa1acvk/ttqyJ14y1OE=
-----END PUBLIC KEY-----
`;

type PublicTrustPolicy = { schema: string; keys: Record<string, string> };

export function releaseArtifactTrust(artifactURL: string, policy: PublicTrustPolicy = publicTrustPolicy) {
  const url = new URL(artifactURL);
  if (url.hostname !== 'github.com') return { name: 'release-development.pub', pem: RELEASE_DEVELOPMENT_TRUST, class: 'development' as const };
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash || parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download') {
    throw new Error('Public component release URL is invalid');
  }
  const match = /^(?:spine|cp|ui)-(beta-)?v[0-9]+(?:\.[0-9]+)*$/.exec(parts[4]);
  if (!match) throw new Error('Public component tag has no supported signing channel');
  const trustClass = match[1] ? 'beta' : 'stable';
  const pem = policy.keys[trustClass];
  if (policy.schema !== 'youeye.public-trust.v1' || !pem || createPublicKey(pem).asymmetricKeyType !== 'ed25519') {
    throw new Error(`Public ${trustClass} trust is not provisioned`);
  }
  return { name: 'release-public.pub', pem, class: trustClass };
}

const MAX_METADATA_BYTES = 1024 * 1024;

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fetchBounded(url: URL, expectedSize?: number): Promise<Buffer> {
  const cached = await cachedReleaseBytes(url.toString());
  if (cached) { if (cached.length > MAX_METADATA_BYTES || (expectedSize !== undefined && cached.length !== expectedSize)) throw new Error('Cached release metadata has invalid size'); return cached; }
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
  const trust = releaseArtifactTrust(artifactURL);
  const [publishedTrust, checksums, signature] = await Promise.all([
    fetchBounded(new URL(trust.name, base)),
    fetchBounded(new URL('SHA256SUMS', base)),
    fetchBounded(new URL('SHA256SUMS.sig', base), 64),
  ]);
  if (!publishedTrust.equals(Buffer.from(trust.pem))) {
    throw new Error('Published release trust anchor does not match the embedded identity');
  }
  if (!verify(null, checksums, createPublicKey(trust.pem), signature)) {
    throw new Error('Release checksum signature is invalid');
  }
  const entries = new Map<string, string>();
  for (const line of checksums.toString('utf8').trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Signed release checksum document is malformed');
    entries.set(match[2], match[1]);
  }
  if (entries.size !== 4 || !entries.has(artifactName) || !entries.has(trust.name) || !entries.has('provenance.json') || !entries.has('sbom.spdx.json')) {
    throw new Error('Signed release checksum set is incomplete');
  }
  if (entries.get(trust.name) !== sha256(publishedTrust)) {
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
  const trust = releaseArtifactTrust(artifactURL);
  const encodedTrust = Buffer.from(trust.pem).toString('base64');
  const expected = expectedDigest?.toLowerCase() ?? '';
  return `
set -eu
verify_dir=$(mktemp -d /tmp/youeye-release-verify.XXXXXX)
trap 'rm -rf -- "$verify_dir"' EXIT
printf %s ${shellQuote(encodedTrust)} | base64 -d >"$verify_dir/embedded.pub"
curl -fsSL ${shellQuote(new URL(trust.name, base).toString())} -o "$verify_dir/published.pub"
curl -fsSL ${shellQuote(new URL('SHA256SUMS', base).toString())} -o "$verify_dir/SHA256SUMS"
curl -fsSL ${shellQuote(new URL('SHA256SUMS.sig', base).toString())} -o "$verify_dir/SHA256SUMS.sig"
cmp -s "$verify_dir/embedded.pub" "$verify_dir/published.pub"
test "$(stat -c %s "$verify_dir/SHA256SUMS.sig")" = 64
openssl pkeyutl -verify -pubin -inkey "$verify_dir/embedded.pub" -rawin -in "$verify_dir/SHA256SUMS" -sigfile "$verify_dir/SHA256SUMS.sig" >/dev/null
test "$(wc -l < "$verify_dir/SHA256SUMS")" = 4
for required in standalone.tar ${shellQuote(trust.name)} provenance.json sbom.spdx.json; do test "$(awk -v name="$required" '$2==name {count++} END {print count+0}' "$verify_dir/SHA256SUMS")" = 1; done
signed=$(awk '$2=="standalone.tar" {print $1}' "$verify_dir/SHA256SUMS")
test "$(sha256sum ${shellQuote(artifactPath)} | awk '{print $1}')" = "$signed"
test -z ${shellQuote(expected)} || test "$signed" = ${shellQuote(expected)}
test "$(sha256sum "$verify_dir/published.pub" | awk '{print $1}')" = "$(awk -v name=${shellQuote(trust.name)} '$2==name {print $1}' "$verify_dir/SHA256SUMS")"
rm -rf -- "$verify_dir"
trap - EXIT
`;
}
