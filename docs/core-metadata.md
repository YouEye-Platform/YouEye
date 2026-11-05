# Core identity and execution compatibility

New Core releases publish four signed metadata assets:

- `core-release-v2.json` and its detached `.sig` authenticate content identity
  without delivery addresses.
- `core-compatibility.json` and its detached `.sig` bind the exact v1 execution
  bytes, exact v2 bytes and normalized identity digest to the same signer,
  source ID, branch and sequence.

The original independently signed `core-release.json` remains the execution
representation during this transition. Transactions, recovery and retained
selection continue to use its exact raw SHA-256. Reformatting or replacing it
changes that identity. The normalized v2 digest is a separate fact.

A publisher identity contains a SHA-256 of the exact canonical original source
URL, its authority class and logical repository name. Each content record keeps
its original name, SHA-256 and size. Original build version, tag, commit, input
digest and provenance digest remain inspectable. Original signed provenance
authenticates source projection or artifact reuse; publication does not rewrite
the original compilation identity. Existing signed compatibility metadata and
published history retain their original addresses.

The verifier resolves **every** original role's current source/branch/scope
authority before accepting an opaque source registry. Owner overrides and
revocations remain effective. A class or ID asserted by an assembly cannot
grant authority. Original-source bindings live only in protected local proof;
public normalized identity does not contain them.

The original role-signed Spine provenance marker `core_metadata:"paired-v2"`
requires the complete pair even if provider advertisements disappear. Unknown
markers, duplicate JSON keys, non-integer wire values, semantic addresses hidden
by JSON escapes, mixed pairs, altered bytes and partial bundles fail closed.
Normalization uses Go struct field order, compact JSON, its HTML/U+2028 escaping
and a final newline. Each raw signed document is also checked independently.

Native selection supplies a protected `core-metadata.json` proof beside the
original execution manifest/signature. Control Panel checks its bounded regular
file, original signatures, complete pair and all current role policies. It never
writes or reserializes that selected proof. An older selection may lack a proof;
before installing an artifact, Control Panel fetches and authenticates the
original signed Spine metadata and any required or advertised pair. Missing
state or publication cannot silently become a legacy decision. Both container
deployment and update await this read-only check before mutation, and exact
authenticated members retain their original tags while using configured scoped
delivery or selected hash mirrors.

The piped Installer performs these checks before advancing its sequence floor or
selecting executable Installer bytes. Its generated script comes from
`releasecache/core_bootstrap.py`; run the source-owned public-trust embedding
tool and its `--check` gate after changes. The appliance's verified bootstrap
invokes `youeye update core verify-metadata` before normal bootstrap when the
authenticated marker or supplied offline metadata requires the pair. Genuine
legacy seven-file inputs remain supported; partial new offline input cannot
downgrade or be replaced by an unrelated cache.

Go, TypeScript and Python consume the same deterministic signed vector in
`releasecache/testdata/core-metadata-v2-vector.json`. Source tests establish these
wire and policy checks. Installed update, interruption, recovery and browser
acceptance still belong to the exact final candidate and target.

The Go Installer independently acquires the same bounded proof during complete
System discovery, before media download, and revalidates it before installation
disk changes. Each of the fourteen original role keys is resolved from this
Installer's compiled public Stable/Beta policy or its embedded development
anchor; the assembly key cannot authorize a reused role. The original signed
Spine provenance determines whether the pair is required, including when the
provider omits all four assets. Authenticated legacy provenance remains valid.

New v5 answers may include `core_release.metadata_proof` as a JSON object.
Existing supplied answers and their relative, digest-bound `release-cache`
remain unchanged. For an older answer without inline proof, acquisition uses a
separate run-owned mode-0600 sidecar; a missing or invalid required proof blocks
installation. The proof is at most 8 MiB and the original v1 manifest digest
remains the transaction identity. No cache object or index is amended.

At the first resumable checkpoint the proof is retained as
`core_metadata_proof` in protected `State/installer/core-selection.json`, bound
to the original transaction, disk serial, media manifest and signed selection.
Resume revalidates it against current compiled anchors and can continue offline.
First-boot initialization also retains the same proof at
`State/bootstrap/core-metadata.json` beside the original manifest/signature for
native consumers. Runtime temporary sidecars are removed when the Installer
returns; State records follow their installation/bootstrap lifecycle. Older
retained records without proof require authenticated acquisition before any
further disk changes, without selecting another release head.

Native initialization, first-boot convergence and CP handoff load that protected
bootstrap proof alongside the exact original manifest/signature. A retained
proof is rechecked against every current role grant, including revocations,
before any fresh-deployment or handoff effects; it needs no metadata refetch or
preexisting Data cache. A malformed retained proof fails closed. Absence uses
normal authenticated acquisition and does not identify a release as legacy.
CP receives run-owned copies of all three verified byte sequences, so replacing
the bootstrap source afterward cannot change the files selected for that push.
