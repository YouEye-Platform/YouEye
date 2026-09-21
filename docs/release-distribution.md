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
