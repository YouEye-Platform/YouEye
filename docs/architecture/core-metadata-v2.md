# Core metadata v2 and the execution compatibility bridge

New publications retain `core-release.json` and its original independent signature
as the execution compatibility representation. Its SHA-256 remains the native
request, journal, committed receipt, rollback and anti-rollback identity. This
rollout does not migrate journals to a new digest.

`core-release-v2.json` contains logical repository/publisher identity, raw publisher
branch, channel, role, original build version/tag/commit/input fingerprint,
checksum/provenance/SBOM identities and exact content names, sizes and hashes. It
contains no deployment addresses. Original signed provenance remains the authority
for an original private-source commit and its explicitly attested clean public
projection; the metadata does not claim that the original commit existed in a
new publisher's repository. Historical v1 documents and public history stay exact.

The four additional release assets are:

- `core-release-v2.json` and `core-release-v2.json.sig`
- `core-compatibility.json` and `core-compatibility.json.sig`

The separately signed compatibility pair binds the exact raw v1 and v2 hashes,
source ID, raw branch, signed sequence, assembly signer fingerprint, and the hash
of the normalized complete identity. Normalization is compact Go struct-order JSON
of `CoreMetadataFromExecution(v1)` with one trailing newline; the shared deterministic
fixture is `releasecache/testdata/core-metadata-v2-vector.json`. There is no hash
cycle and no permission to equate arbitrary same-sequence documents. Unknown
schemas, reader versions, required capabilities and announcements fail closed.

A source ID is the SHA-256 of the exact validated canonical original source URL.
The protected local source registry is derived only after the independently
signed v1 assembly and every selected role pass their current source/branch/scope
policy. Neither an opaque ID nor an assembly's authority-class assertion enrolls
a key. Every use resolves current owner overrides and revocations again; downloaded
public keys never become trust anchors. Deployment URLs occur only in legacy
execution metadata and protected local bindings. Blob delivery is rooted in the
selected transport and every payload still requires its original hash and scoped
role signature.

Newly built Spine's original checksum-bound signed provenance announces
`core_metadata: "paired-v2"`. Readers authenticate its bounded checksums, signature
and provenance before deciding whether the four documents are optional. A required
or advertised missing, partial, wrong or modified bundle is an error. Stripping the
asset list cannot remove the signed announcement. Genuine historical signed Spine
provenance without an announcement remains supported. No binary is downloaded to
make this decision.

The installed reader retains an authenticated `core-metadata.json` proof alongside
CP's exact selection and a `<v1-digest>.metadata.json` sidecar beside retained native
targets. Its Data cache is `cache/core-update/metadata-v2/<v1-digest>.json`. Proofs
include the exact signed announcement and pair documents, allowing offline
continuation/recovery while rechecking current trust. Malformed saved proof fails
closed. Before effects both target and previous selection are authenticated and
retained. A genuinely legacy CP checkpoint can predate its proof sidecar.

The root-only `youeye update core verify-metadata --manifest FILE --signature FILE`
verifies bounded metadata and prints both digests without creating a request,
staging payloads or activating an update. `--inputs DIR` accepts the existing
original Spine envelope names `artifact`, `checksums`, `signature`, `provenance`,
`sbom`, `core-release.json`, `core-release.json.sig`, plus the four additional
metadata assets. A supplied required incomplete offline bundle fails; it does not
fall back to a weaker representation. Old 0.5.65 intentionally executes the exact
v1 bridge with its normal checks. New runtime re-entry verifies the full pair.

Pure v2-native execution, a journal digest migration, deletion of retained v1, and
new publisher enrollment are separate future changes.
