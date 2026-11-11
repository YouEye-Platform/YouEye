# Public snapshot release contract

A GitHub release projects reviewed source into one new public commit, preserving
previous public release history without importing private development ancestry.
GitHub beta uses four numeric version positions and beta-prefixed component tags;
GitHub main uses three positions and main component tags. Direct alpha-to-main
release preparation is supported by the publishing coordinator.

Public appliance source declares `.youeye/release/github.json`. The image build
reads a detached `youeye.build-inputs.v1` file (`build-inputs.json`) naming the
exact Spine, Control Panel and UI artifacts by version, tag, source commit and
SHA-256; artifact hashes never live in a self-referential source commit. The
build writes unsigned `appliance-manifest.json` and
`system-update-manifest.json`, and `scripts/assemble-core-release.py` binds them
and every other asset into `core-release.json`. Releases are unsigned for now;
there are no public keys or `.pub` assets.

The Proxmox bootstrap (`installer/scripts/install.sh`) is a single pipeable
file with no generated sections; it embeds no keys and needs no preparation
step before a snapshot is committed.

Public Pointer releases use `v<version>` (Stable) or `beta-v<version>`
(Beta), while core components use their `spine-`, `cp-`, and `ui-` prefixes.
The component verifier recognizes unprefixed tags only in the official
`YouEye-Platform/Pointer` repository and requires the matching artifact digest.

A sealed runtime reports public Stable images with `artifact_kind: stable`.
Control Panel maps both this value and the legacy `production` value to the
Stable system-update channel; it must not infer Development from the newer
name. Explicit saved update-source selections continue to take precedence.

System-update discovery treats an already-installed release as a no-op
only when its source commit and component release set match the installed
identity. It still verifies the requested branch and exact digests;
staging retains its replay rejection. Discovery does not create a new update
transaction for the installed release.

Managed Pointer configuration forwards the public build identity from its
artifact's `release-manifest.json` to readiness reporting. App identity
variables use the app's client-specific issuer and discovery URL, matching the
SSO token authority; no generic root OIDC discovery endpoint is advertised.

Pointer deployment installs its runtime and service definition without
starting the service until managed configuration and database migration finish.
The doctor probes Pointer's application readiness directly; other apps without
reported readiness are shown as unknown rather than inferred healthy from a
running container alone.

A System release `youeye-v<version>` carries `core-release.json`, which lists
every artifact by exact URL, SHA-256 and size. Both the bootstrap and the
Installer check every artifact they use against that document; there are no
signature or public-key assets.

An unsigned quick Installer overlay can validate the binary and access helper
on an existing appliance. It does not rebuild the ISO or prove the public
bootstrap-to-fresh-install journey. Release acceptance must exercise the root
Proxmox command, VM creation, ISO installation, first deployment and setup
readiness against the exact published artifacts.

Creating a source contract does not publish a release, promote development
source, or install/update a machine. Full build and native install/update
acceptance must be recorded separately by the release owner.
