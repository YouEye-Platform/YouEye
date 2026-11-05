# Repository-owned build entrypoints

These executable entrypoints are the component build boundary used by the
dedicated release builder:

- `spine` emits `spine-linux-amd64`;
- `installer` emits an unsigned, appliance-owned runtime overlay for the
  reversible development deployment lane; it has no independent release version,
  is not an ISO, and is never an independently publishable release;
- `control-panel` and `ui` each emit an uncompressed `standalone.tar` rooted at
  `server.js`;
- `appliance` emits the nine unsigned appliance/installer outputs expected by
  independent Infra validation and signing.

Every entrypoint requires `YOUEYE_SOURCE_DIR`, `YOUEYE_WORK_DIR`,
`YOUEYE_OUTPUT_DIR`, `YOUEYE_SOURCE_COMMIT`, and `SOURCE_DATE_EPOCH`. Git
metadata is optional: when it exists, the supplied commit must match it. Node
builds require pnpm `10.6.2` and always use `--frozen-lockfile`; there is no
unlocked dependency fallback. Entrypoints build only. They never sign, publish,
or accept credentials.

The strict manifests under `manifests/` declare stable build mechanics and
pinned build requirements. Release versions, candidate commits, tags and the
signing lane are bound by the release control plane at request time. Node
entrypoints use a reviewed shared content-addressed pnpm store in offline,
frozen-lockfile mode; it is cache only and never source or artifact truth.
The appliance entrypoint uses the job-local, no-egress APT broker for both
`mmdebstrap` and `live-build`; Debian's signed Release metadata and package
hashes remain authoritative, and a cache miss fails rather than enabling direct
network access.

## Appliance release-train handoff

The Alex handoff is deliberately limited to this input contract.
`appliance/build/generate-release-train-input.sh DESTINATION` validates the
repository release lock and writes the deterministic product-side
`youeye.appliance.train-input.v1` adapter output. It is not an Infra manifest or
an extension to Infra's schema. The smallest handoff contains only the
public-neutral destination identifier,
provider, channel, exact appliance/image identity, exact component tags,
commits/checksums, and Market source/channel/commit. `github` is the public
no-override default. Forgejo and custom sources require explicit custom source
mode plus an HTTPS releases API; no credentials, executor identity, signing
authority, publication action, deployment action, or Stable authority is
represented here. The receiving control plane registers its executor under
its own policy and preserves its existing supported manifest enums and trust
classes.

This handoff prepares a train only. It does not build an appliance, perform an
A/B build, sign, publish, deploy, or alter Development trust. The existing
build manifests are left schema-compatible; executor registration is a
public-neutral control-plane responsibility rather than a new repository
manifest field.
