# Public snapshot release contract

A GitHub release projects reviewed source into one new public commit, preserving
previous public release history without importing private development ancestry.
GitHub beta uses four numeric version positions and beta-prefixed component tags;
GitHub main uses three positions and main component tags. Direct alpha-to-main
release preparation is supported by the publishing coordinator.

Public appliance source declares `.youeye/release/github.json` and contains
`appliance/release-recipe.json` with schema `youeye.appliance.recipe.v1`, an
`image` object matching release-lock image fields, and `market_branch`. The exact
build receives a detached `youeye.appliance.release-lock.v1` lock. Image metadata
must equal the committed recipe; all core component pins name the final source
commit. Artifact hashes belong in this detached lock, never in a self-referential
source commit. Signed provenance binds its exact digest.

`APPLIANCE_TRUST_CLASS` is development, beta or stable. Public beta must use beta;
public stable must use main. The reviewed public projection installs Ed25519
public anchors in Installer and updater `public-release-trust.json` files and
selects `appliance-public.pub`. Default development source contains no public
release keys and cannot authorize beta/stable signatures. Public releases use the
compiled channel anchor, never a caller-supplied or downloaded replacement key.
The legacy bundle asset name `appliance-development.pub` remains for compatibility;
its key bytes and signed trust class identify the actual selected public signer.

After provisioning the reviewed public anchors and **before** committing the
projected snapshot, run:

```sh
python3 installer/scripts/embed-public-trust.py
python3 installer/scripts/embed-public-trust.py --check --require stable
```

Use `--require beta` for a beta snapshot. This embeds the same source-owned
public policy into the single-file, pipeable Proxmox bootstrap. It accepts no
downloaded key override and rejects the Development key as a public anchor.
The appliance build checks this parity without modifying source; a coordinator
that only writes the Go policy must add this preparation step before freezing
the source commit. Do not generate a different bootstrap after the commit.

Public Pointer releases use `v<version>` (Stable) or `beta-v<version>`
(Beta), while core components use their `spine-`, `cp-`, and `ui-` prefixes.
The component verifier recognizes unprefixed tags only in the official
`YouEye-Platform/Pointer` repository and still requires the embedded public
channel key, signed checksum document, and matching artifact digest.

A sealed runtime reports public Stable images with `artifact_kind: stable`.
Control Panel maps both this value and the legacy `production` value to the
Stable system-update channel; it must not infer Development from the newer
name. Explicit saved update-source selections continue to take precedence.

System-update discovery treats an already-installed signed release as a no-op
only when its source commit and component release set match the installed
identity. It still verifies signatures, requested branch and exact digests;
staging retains its replay rejection. Discovery does not create a new update
transaction for the installed release.

Managed Pointer configuration forwards the public build identity from its
signed artifact's `release-manifest.json` to readiness reporting. App identity
variables use the app's client-specific issuer and discovery URL, matching the
SSO token authority; no generic root OIDC discovery endpoint is advertised.

Pointer deployment installs its signed runtime and service definition without
starting the service until managed configuration and database migration finish.
The doctor probes Pointer's application readiness directly; other apps without
reported readiness are shown as unknown rather than inferred healthy from a
running container alone.

Public appliance releases contain exactly 19 assets: the existing 16
checksum-covered assets, `SHA256SUMS`, `SHA256SUMS.sig`, and the detached
`release-lock.json`. The lock is bound by `resolved_lock_sha256` in
checksum-covered `provenance.json`; it is not an extra checksum entry. Both
bootstrap and Installer verify this chain and compare the lock's image, source,
component and Market pins with signed metadata. Historical 18-asset Development
releases remain supported; a lock supplied by a newer Development release must
also pass verification. Extra or duplicate assets remain errors.

An unsigned quick Installer overlay can validate the binary and access helper
on an existing appliance. It does not rebuild the ISO or prove the public
bootstrap-to-fresh-install journey. Release acceptance must exercise the root
Proxmox command, VM creation, ISO installation, first deployment and setup
readiness against the exact signed artifacts.

Creating a source contract does not publish a release, provision signing keys,
promote development source, or install/update a machine. Full signed build and
native install/update acceptance must be recorded separately by the release owner.
