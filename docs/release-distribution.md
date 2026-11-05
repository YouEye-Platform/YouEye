# Public release discovery

Public builds use `https://releases.youeye.me` for signed release metadata.
The source repository/provider remains GitHub; the distribution service is a
transport for discovery, not a replacement release identity. Release artifacts
remain on GitHub Releases and retain their existing signature, checksum and
provenance verification. Custom providers and third-party repositories retain
their existing discovery behavior.

The public bootstrap is `/install.sh`. `/v1/stable.json` and `/v1/beta.json`
contain Ed25519-signed catalogs. Each envelope contains base64 `payload` and
`signature`; verification covers the exact decoded payload bytes. The payload
schema is `youeye.distribution.v1`, with channel, monotonically increasing
sequence, issue/expiry timestamps and repository release records. Catalogs
also carry the published Market branch-to-commit mapping. Original release
URLs are preserved for subsequent identity validation.

The public build process provisions `releasecache/distribution-policy.json`
with the origin and independently configured stable/beta public anchors. The
source default has an empty origin so private development discovery is unchanged.
`installer/scripts/embed-public-trust.py` generates the shell and boot-network
readers from `releasecache/distribution.py` and verifies matching public anchors.
Run its `--check` mode after any reader or public trust change.

The Go transport, Control Panel and shell reader validate signatures, channel,
expiry and artifact origins before resolving releases. They cache verified
catalogs for 15 minutes and retain sequence/digest state across restarts in the
process user's cache directory (the bootstrap uses its installer cache).
Services without a home environment use the account's registered home directory;
on the appliance, root's home is backed by persistent State.
`YOUEYE_DISTRIBUTION_STATE` redirects the Go/Control Panel cache for isolated
tests. An existing signed local staging cache takes precedence for explicitly
staged releases. Deleting the retained cache also removes its replay watermark;
a new installation can only establish freshness from the signed expiry and its
clock. Separate concurrent processes do not share an atomic sequence lock.

Catalog validity is at most 31 days. A previously unseen missing channel is
empty; an unavailable, invalid, expired or regressed configured catalog is an
error. Clients do not silently fall back to anonymous GitHub API discovery.
Offline installation requires the existing verified staged-release workflow.

## Troubleshooting

- Metadata expiry: check the machine's UTC clock, then the distribution status.
  Operators renew catalogs from retained publication state; end users need no
  GitHub token.
- HTTP errors from the distribution host: retry after the operator restores
  the last verified publication. Do not bypass signatures or edit the policy.
- GitHub API 403 on older installers: use the current canonical bootstrap.
  Already-installed older versions need a compatible update before their
  normal discovery stops using GitHub API quota.
- TLS/SNI failures are separate from API quota. Check DNS, TLS interception and
  IPv4/IPv6 connectivity. Do not disable certificate verification.

Artifact hosting still depends on GitHub download availability. Moving large
artifacts to another object store is a separate migration; this change removes
anonymous API quota from normal first-party release discovery.

## Hosted official Market and app updates

Public builds resolve official Market channel commits through the signed
Stable/Beta envelopes at `https://catalog.youeye.me`. Files in that Market
repository are read at `/v1/snapshots/<exact-commit>/<source-path>` on the same
host. Relative manifest and image paths stay intact. Native app entries that
reference separate repositories keep those references and use their own declared
branch or commit. They never inherit the Market repository commit; entries without
a declared ref use the source channel (or main for a commit-pinned Market source).
Manifest assets and recorded provenance use that same app repository ref. Explicit custom Git
sources retain their configured providers, and development builds without a
public distribution policy keep their existing transport.

The channel signature authenticates the selected Git commit. Snapshot files
use HTTPS and the publisher's verified Git extraction; the mirror's SHA-256
inventory is not itself a signed trust root. Failure to fetch an exact snapshot
file never substitutes that file from a floating main branch. Protected candidate
install caches retain precedence and can serve their original Git-URL-indexed
bytes through the hosted URL for the same exact commit and path.

Settings, queued LXD updates and exact-tag updates share channel resolution and
protected release transport. They do not execute a separate release-discovery
curl inside the app container. Official repository names are recognized with
GitHub's case-insensitive semantics. A selected custom source remains attached
to exact artifact resolution. Downloads still come from the selected release
host and retain signature/checksum verification before extraction. Initial UI/AI release discovery uses the same protected transport. Exact AI deployment also recognizes unprefixed `v` tags and continues to require the signed artifact digest.

Existing installations need a Control Panel update to adopt these paths. The
change does not require a new host image or a GitHub token in a VM/template.

## Independent service installation

A public channel may carry an `installation` selection with schema
`youeye.installation.v1`. The signed envelope binds one exact appliance version,
tag, source commit, manifest digest and baked Spine digest to independently
versioned Control Panel and UI artifacts. Each service records its immutable tag,
source commit and artifact SHA-256. This is an accepted combination, not a request
to choose unrelated latest releases at installation time.

Compatible appliances resolve this selection during tracked public first boot.
They verify the normal distribution signature, expiry and rollback watermark,
check that the selection names the running image and Spine, then durably save
its signed envelope before changing service pins. A retry verifies and reuses
that protected snapshot, including after metadata expiry; expiry prevents new
selections, not recovery of an already accepted deployment. Service downloads
retain their existing signed-checksum and artifact verification.

Exact-image installation defaults to the image's sealed service pins. The native
installer's `--service-selection current` explicitly requests current compatible
services for that exact image. `--service-selection sealed` retains image pins
for a tracked installation too. Private providers retain their existing sealed
selection behavior. A missing or incompatible public selection fails closed.

Fresh-install health checks use the frozen service selection while continuing to
verify baked Spine against the sealed image. This does not rewrite image
provenance or authorize a host-image update. Existing installations continue to
use ordinary independent service updates.

Older appliances predate this reader and still use sealed pins. Moving first
boot to this contract therefore requires an appliance containing the updated
Spine; later service releases can reuse that image. Original image releases,
pins and exact-install recovery remain available.


## Native Market package trust

Native Market installations and updates accept unsigned packages when the release
advertises no signing key or signature. A release that advertises signing evidence
must provide a complete, unambiguous bundle and pass verification; incomplete,
mixed-authority or invalid evidence never falls back to unsigned installation.
Official public native apps use the embedded Stable/Beta authority for their
`v...` / `beta-v...` tags. Private development signatures retain their own authority.
Installed artifact provenance records the actual verified signing class.

GitHub package downloads may follow HTTPS redirects to its release-assets CDN,
with bounded redirects and download size. Other sources retain same-origin
redirects. Signature and checksum checks still run before archive inspection or
installation. Safe package-policy errors are retained in the install operation's
message; arbitrary dependency details remain redacted.

Original official native manifests that still name their pre-publication repository
are mapped to the matching public app repository when read from the official
GitHub Market. This compatibility mapping requires the exact known legacy name
and matching native manifest repository; custom markets, forks, explicit URL
sources and unrelated repositories are unchanged.
